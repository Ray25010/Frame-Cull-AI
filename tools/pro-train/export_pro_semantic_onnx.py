#!/usr/bin/env python
"""Export FrameCull Pro Semantic Student V2 to ONNX manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn

from train_semantic_student import SCALAR_HEADS, SemanticStudent


class PersonaHead(nn.Module):
    def __init__(self, feat_dim: int, hidden: int = 256):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(feat_dim),
            nn.Linear(feat_dim, hidden),
            nn.GELU(),
            nn.Dropout(0.15),
            nn.Linear(hidden, 1),
        )

    def forward(self, feat):
        return self.net(feat).squeeze(-1)


class SemanticExportModel(nn.Module):
    def __init__(
        self,
        student: SemanticStudent,
        aesthetic_mean: float,
        aesthetic_std: float,
        persona_head: PersonaHead | None = None,
        has_independent_false_face_risk_head: bool = False,
    ):
        super().__init__()
        self.student = student
        self.aesthetic_mean = float(aesthetic_mean)
        self.aesthetic_std = float(aesthetic_std)
        self.persona_head = persona_head
        self.has_independent_false_face_risk_head = bool(has_independent_false_face_risk_head)

    def forward(self, pixel_values):
        feat = self.student.backbone(pixel_values)
        out = {
            "aesthetic": self.student.aesthetic_head(feat).squeeze(-1),
            "scene_logits": self.student.scene_head(feat),
            "semantic_keep": self.student.semantic_keep_head(feat).squeeze(-1),
            "face_validity": self.student.face_validity_head(feat).squeeze(-1),
            "composition": self.student.composition_head(feat).squeeze(-1),
            "moment": self.student.moment_head(feat).squeeze(-1),
            "lighting": self.student.lighting_head(feat).squeeze(-1),
        }
        if self.has_independent_false_face_risk_head:
            out["false_face_risk"] = self.student.false_face_risk_head(feat).squeeze(-1)
        aesthetic_raw = out["aesthetic"] * self.aesthetic_std + self.aesthetic_mean
        aesthetic = torch.clamp(aesthetic_raw / 100.0, 0.0, 1.0).unsqueeze(-1)
        semantic_keep = torch.sigmoid(out["semantic_keep"]).unsqueeze(-1)
        face_validity = torch.sigmoid(out["face_validity"]).unsqueeze(-1)
        composition = torch.sigmoid(out["composition"]).unsqueeze(-1)
        moment = torch.sigmoid(out["moment"]).unsqueeze(-1)
        lighting = torch.sigmoid(out["lighting"]).unsqueeze(-1)
        false_face_risk = (
            torch.sigmoid(out["false_face_risk"]).unsqueeze(-1)
            if self.has_independent_false_face_risk_head
            else 1.0 - face_validity
        )
        outputs = [
            aesthetic,
            out["scene_logits"],
            semantic_keep,
            face_validity,
            composition,
            moment,
            lighting,
            false_face_risk,
        ]
        if self.persona_head is not None:
            outputs.insert(2, torch.sigmoid(self.persona_head(feat)).unsqueeze(-1))
        return tuple(outputs)


def load_persona_head(path: str | Path, ckpt: dict, student: SemanticStudent) -> tuple[PersonaHead, dict]:
    payload = torch.load(path, map_location="cpu")
    state = payload.get("persona_head")
    if not state:
        raise RuntimeError(f"{path} missing persona_head state")
    feat_dim = int(payload.get("feat_dim") or 0)
    if feat_dim != int(student.feat_dim):
        raise RuntimeError(f"{path} feat_dim mismatch: {feat_dim} vs semantic student {student.feat_dim}")
    input_size = int(payload.get("input_size") or 0)
    if input_size != int(ckpt["input_size"]):
        raise RuntimeError(f"{path} input_size mismatch: {input_size} vs semantic student {ckpt['input_size']}")
    backbone = str(payload.get("backbone") or "")
    if backbone and backbone != str(ckpt["backbone"]):
        raise RuntimeError(f"{path} backbone mismatch: {backbone} vs semantic student {ckpt['backbone']}")
    student_schema = str(payload.get("student_schema") or "")
    semantic_schema = str(ckpt.get("schema") or "")
    if student_schema and semantic_schema and student_schema != semantic_schema:
        raise RuntimeError(f"{path} student schema mismatch: {student_schema} vs {semantic_schema}")
    hidden = int(payload.get("persona_hidden") or state["net.1.weight"].shape[0])
    head = PersonaHead(student.feat_dim, hidden)
    head.load_state_dict(state)
    head.eval()
    return head, {
        "schema": payload.get("schema") or "framecull-pro-persona-head-v1",
        "studentSchema": student_schema or None,
        "studentType": payload.get("student_type") or None,
        "ratingSrcc": payload.get("rating_srcc"),
        "valMetrics": payload.get("val_metrics"),
        "allMetrics": payload.get("all_metrics"),
        "labelPolicy": payload.get("label_policy"),
        "checkpoint": str(path),
        "hidden": hidden,
    }


def sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_onnx(path: str | Path, batch: int = 2) -> dict:
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(42)
    x = rng.normal(0, 1, size=(batch, 3, 384, 384)).astype("float32")
    outs = sess.run(None, {"pixel_values": x})
    names = [item.name for item in sess.get_outputs()]
    ranges = {}
    for name, value in zip(names, outs):
        if value.ndim == 2 and value.shape[1] == 1:
            ranges[name] = [float(value.min()), float(value.max())]
    return {
        "providers": sess.get_providers(),
        "outputs": names,
        "shapes": [list(value.shape) for value in outs],
        "scalarRanges": ranges,
    }


def compare_onnx(fp32_path: str | Path, int8_path: str | Path, batch: int = 4) -> dict:
    fp32 = ort.InferenceSession(str(fp32_path), providers=["CPUExecutionProvider"])
    int8 = ort.InferenceSession(str(int8_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(123)
    x = rng.normal(0, 1, size=(batch, 3, 384, 384)).astype("float32")
    fp32_out = fp32.run(None, {"pixel_values": x})
    int8_out = int8.run(None, {"pixel_values": x})
    names = [item.name for item in fp32.get_outputs()]
    outputs = {}
    max_abs = 0.0
    for name, left, right in zip(names, fp32_out, int8_out):
        delta = np.abs(left.astype("float32") - right.astype("float32"))
        item = {
            "shape": list(left.shape),
            "maxAbs": float(delta.max()),
            "meanAbs": float(delta.mean()),
        }
        outputs[name] = item
        max_abs = max(max_abs, item["maxAbs"])
    return {
        "schema": "framecull-pro-semantic-quant-compare-v1",
        "batch": batch,
        "maxAbs": max_abs,
        "outputs": outputs,
    }


def maybe_quantize(fp32_path: str, int8_path: str) -> tuple[bool, dict]:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    attempts = [
        ("dynamic-matmul-gemm", ["MatMul", "Gemm"]),
        ("dynamic-matmul", ["MatMul"]),
        ("dynamic-gemm", ["Gemm"]),
    ]
    errors = []
    for name, ops in attempts:
        candidate = int8_path.replace(".onnx", f".{name}.onnx")
        try:
            quantize_dynamic(
                fp32_path,
                candidate,
                op_types_to_quantize=ops,
                per_channel=False,
                weight_type=QuantType.QInt8,
                use_external_data_format=False,
            )
            validate_onnx(candidate, batch=1)
            os.replace(candidate, int8_path)
            return True, {"strategy": name, "errors": errors}
        except Exception as error:
            errors.append({"strategy": name, "error": str(error)})
            if os.path.exists(candidate):
                try:
                    os.remove(candidate)
                except OSError:
                    pass
    return False, {"strategy": None, "errors": errors}


def build_manifest(
    args,
    ckpt: dict,
    model_name: str,
    model_file: str,
    model_sha: str,
    quantization: dict | None = None,
    persona_meta: dict | None = None,
    has_independent_false_face_risk_head: bool = False,
) -> dict:
    scene_labels = ckpt["scene_labels"]
    heads = [
        {"name": "aesthetic", "output": "aesthetic", "kind": "scalar01"},
        {"name": "scene", "output": "scene_logits", "kind": "classifier", "labels": scene_labels},
    ]
    if persona_meta is not None:
        heads.append({"name": "persona", "output": "persona", "kind": "scalar01"})
    heads.extend([
        {"name": "semantic_keep", "output": "semantic_keep", "kind": "scalar01"},
        {"name": "face_validity", "output": "face_validity", "kind": "scalar01"},
        {"name": "composition", "output": "composition", "kind": "scalar01"},
        {"name": "moment", "output": "moment", "kind": "scalar01"},
        {"name": "lighting", "output": "lighting", "kind": "scalar01"},
        {"name": "false_face_risk", "output": "false_face_risk", "kind": "scalar01"},
    ])
    manifest = {
        "schemaVersion": 1,
        "backboneVersion": model_name,
        "model": model_file,
        "sha256": model_sha,
        "inputName": "pixel_values",
        "inputResolution": int(ckpt["input_size"]),
        "channels": 3,
        "normalize": {
            "mean": [0.485, 0.456, 0.406],
            "std": [0.229, 0.224, 0.225],
        },
        "heads": heads,
        "labNotes": {
            "semanticSchema": "framecull-semantic-teacher-v1",
            "studentSchema": ckpt.get("schema"),
            "teacherFlatScalar": bool(ckpt.get("teacher_flat_scalar", False)),
            "studentCheckpoint": str(args.student),
            "scalarHeads": SCALAR_HEADS,
            "faceHeadSupervision": ckpt.get("face_head_supervision"),
            "hasIndependentFalseFaceRiskHead": has_independent_false_face_risk_head,
            "derivedOutputs": {} if has_independent_false_face_risk_head else {
                "falseFaceRisk": "1 - face_validity",
            },
            "dinoDim": ckpt.get("dino_dim"),
            "clipDim": ckpt.get("clip_dim"),
            "metrics": ckpt.get("metrics"),
            "qaOnlyFieldsNotExported": [
                "storytellingScore",
                "emptyOrFillerScore",
                "technicalVisibleIssueScore",
                "scenicValueScore",
            ],
        },
    }
    if quantization is not None:
        manifest["labNotes"]["quantization"] = quantization
    if persona_meta is not None:
        manifest["labNotes"]["personaHead"] = persona_meta
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--student", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default="framecull-pro-semantic-v2")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--persona")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    student_path = Path(args.student)
    student_training_report = student_path.with_name("training-report.json")
    if not student_training_report.exists():
        raise RuntimeError(f"Missing semantic student training report: {student_training_report}")
    ckpt = torch.load(args.student, map_location="cpu")
    dino_dim = int(ckpt.get("dino_dim") or 0)
    if dino_dim != 768:
        raise RuntimeError(f"Semantic Student V2 export requires dino_dim=768, got {dino_dim}")
    student = SemanticStudent(
        ckpt["backbone"],
        clip_dim=int(ckpt["clip_dim"]),
        dino_dim=dino_dim,
        scene_count=len(ckpt["scene_labels"]),
        input_size=int(ckpt["input_size"]),
        pretrained=False,
    )
    model_state = ckpt["model"]
    has_independent_false_face_risk_head = bool(
        ckpt.get("has_independent_false_face_risk_head", False)
        and any(str(key).startswith("false_face_risk_head.") for key in model_state)
    )
    if has_independent_false_face_risk_head:
        student.load_state_dict(model_state)
    else:
        missing, unexpected = student.load_state_dict(model_state, strict=False)
        unexpected = list(unexpected)
        missing = list(missing)
        if unexpected:
            raise RuntimeError(f"unexpected checkpoint keys: {unexpected[:8]}")
        unexpected_missing = [key for key in missing if not str(key).startswith("false_face_risk_head.")]
        if unexpected_missing:
            raise RuntimeError(f"missing checkpoint keys beyond false_face_risk_head: {unexpected_missing[:8]}")
    aesthetic_norm = ckpt.get("aesthetic_norm") or {}
    persona_head = None
    persona_meta = None
    if args.persona:
        persona_head, persona_meta = load_persona_head(args.persona, ckpt, student)
    model = SemanticExportModel(
        student,
        float(aesthetic_norm.get("mean", 50.0)),
        float(aesthetic_norm.get("std", 10.0)),
        persona_head=persona_head,
        has_independent_false_face_risk_head=has_independent_false_face_risk_head,
    ).eval()
    for param in model.parameters():
        param.requires_grad_(False)

    fp32_path = os.path.join(args.out, "model.onnx")
    dummy = torch.randn(2, 3, int(ckpt["input_size"]), int(ckpt["input_size"]))
    output_names = [
        "aesthetic",
        "scene_logits",
    ]
    if persona_head is not None:
        output_names.append("persona")
    output_names.extend([
        "semantic_keep",
        "face_validity",
        "composition",
        "moment",
        "lighting",
        "false_face_risk",
    ])
    dynamic_axes = {"pixel_values": {0: "batch"}}
    dynamic_axes.update({name: {0: "batch"} for name in output_names})
    torch.onnx.export(
        model,
        dummy,
        fp32_path,
        input_names=["pixel_values"],
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=args.opset,
        do_constant_folding=True,
        external_data=False,
        dynamo=False,
    )
    model_proto = onnx.load(fp32_path, load_external_data=True)
    onnx.save_model(model_proto, fp32_path, save_as_external_data=False)
    data_sidecar = fp32_path + ".data"
    if os.path.exists(data_sidecar):
        os.remove(data_sidecar)
    onnx.checker.check_model(onnx.load(fp32_path))
    fp32_validation = validate_onnx(fp32_path)

    int8_path = os.path.join(args.out, "model.int8.onnx")
    quantized, quantization = maybe_quantize(fp32_path, int8_path)
    int8_validation = validate_onnx(int8_path) if quantized else None
    quant_compare = compare_onnx(fp32_path, int8_path) if quantized else {
        "schema": "framecull-pro-semantic-quant-compare-v1",
        "status": "not-quantized",
        "quantization": quantization,
    }

    fp32_manifest = build_manifest(
        args,
        ckpt,
        args.name,
        "model.onnx",
        sha256(fp32_path),
        persona_meta=persona_meta,
        has_independent_false_face_risk_head=has_independent_false_face_risk_head,
    )
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(fp32_manifest, handle, ensure_ascii=False, indent=2)

    int8_manifest = None
    if quantized:
        int8_manifest = build_manifest(
            args,
            ckpt,
            f"{args.name}-int8-linear",
            "model.int8.onnx",
            sha256(int8_path),
            quantization,
            persona_meta=persona_meta,
            has_independent_false_face_risk_head=has_independent_false_face_risk_head,
        )
        with open(os.path.join(args.out, "manifest.int8.json"), "w", encoding="utf-8") as handle:
            json.dump(int8_manifest, handle, ensure_ascii=False, indent=2)

    report = {
        "schema": "framecull-pro-semantic-export-v1",
        "student": {
            "path": str(args.student),
            "sha256": sha256(args.student),
            "schema": ckpt.get("schema"),
            "teacherFlatScalar": bool(ckpt.get("teacher_flat_scalar", False)),
        },
        "persona": {
            "path": str(args.persona) if args.persona else None,
            "sha256": sha256(args.persona) if args.persona else None,
            "meta": persona_meta,
        },
        "fp32": {
            "path": fp32_path,
            "sha256": fp32_manifest["sha256"],
            "bytes": os.path.getsize(fp32_path),
            "validation": fp32_validation,
        },
        "int8": {
            "path": int8_path if quantized else None,
            "sha256": int8_manifest["sha256"] if int8_manifest else None,
            "bytes": os.path.getsize(int8_path) if quantized else None,
            "validation": int8_validation,
            "quantization": quantization,
        },
    }
    with open(os.path.join(args.out, "quant-compare.json"), "w", encoding="utf-8") as handle:
        json.dump(quant_compare, handle, ensure_ascii=False, indent=2)
    teacher_schema = {
        "schemaVersion": "framecull-semantic-teacher-v1",
        "exportedStudent": args.name,
        "heads": fp32_manifest["heads"],
        "teacherToStudentMapping": fp32_manifest["labNotes"]["scalarHeads"],
        "qaOnlyFieldsNotExported": fp32_manifest["labNotes"]["qaOnlyFieldsNotExported"],
    }
    with open(os.path.join(args.out, "teacher-schema.json"), "w", encoding="utf-8") as handle:
        json.dump(teacher_schema, handle, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "selected-model-manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(int8_manifest or fp32_manifest, handle, ensure_ascii=False, indent=2)
    training_report_copy = Path(args.out) / "training-report.json"
    shutil.copy2(student_training_report, training_report_copy)
    report["studentTrainingReport"] = {
        "source": str(student_training_report),
        "copiedPath": str(training_report_copy),
        "copied": bool(training_report_copy.exists()),
    }
    with open(os.path.join(args.out, "export-report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print("==SEMANTIC_EXPORT_DONE==", json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
