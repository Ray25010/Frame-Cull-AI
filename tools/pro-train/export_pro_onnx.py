#!/usr/bin/env python
"""Export distilled student + persona head to the Pro native ONNX contract.

ONNX input:
  pixel_values: float32 [N,3,384,384], already ImageNet-normalized by Rust.

ONNX outputs required by `src-tauri/src/pro_infer/infer.rs`:
  aesthetic:    float32 [N,1], 0..1
  scene_logits: float32 [N,4], placeholder classifier logits for this lab round
  persona:      float32 [N,1], 0..1

The scene logits are not a production scene classifier yet. They are exported
only to keep the §10 manifest contract stable; production routing should ignore
scene until a labeled scene head is trained.
"""
import argparse
import hashlib
import json
import os

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn

from train_distill_backbone import MultiHeadStudent
from train_persona_head import PersonaHead


class ProExportModel(nn.Module):
    def __init__(self, student, persona_head):
        super().__init__()
        self.student = student
        self.persona_head = persona_head

    def forward(self, pixel_values):
        feat = self.student.backbone(pixel_values)
        aes_z = self.student.aes_head(feat).squeeze(-1)
        scene_embedding = self.student.scene_head(feat)
        persona_logit = self.persona_head(feat)

        aesthetic = torch.sigmoid(aes_z).unsqueeze(-1)
        scene_logits = scene_embedding[:, :4]
        persona = torch.sigmoid(persona_logit).unsqueeze(-1)
        return aesthetic, scene_logits, persona


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_onnx(path, batch=3):
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    x = np.random.default_rng(42).normal(0, 1, size=(batch, 3, 384, 384)).astype("float32")
    out = sess.run(None, {"pixel_values": x})
    return {
        "providers": sess.get_providers(),
        "outputs": [o.name for o in sess.get_outputs()],
        "shapes": [list(v.shape) for v in out],
        "aestheticRange": [float(out[0].min()), float(out[0].max())],
        "personaRange": [float(out[2].min()), float(out[2].max())],
    }


def maybe_quantize(fp32_path, int8_path):
    from onnxruntime.quantization import QuantType, quantize_dynamic

    # Do not quantize Conv here: ORT CPU may emit ConvInteger nodes without a
    # portable kernel. Quantize only transformer/MLP-style linear operators.
    attempts = [
        ("dynamic-matmul-gemm", ["MatMul", "Gemm"]),
        ("dynamic-matmul", ["MatMul"]),
        ("dynamic-gemm", ["Gemm"]),
    ]
    errors = []
    for name, ops in attempts:
        candidate = int8_path if name == "dynamic-all" else int8_path.replace(".onnx", f".{name}.onnx")
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
        except Exception as e:
            errors.append({"strategy": name, "error": str(e)})
            if os.path.exists(candidate):
                try:
                    os.remove(candidate)
                except OSError:
                    pass
    return False, {"strategy": None, "errors": errors}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--student", required=True)
    ap.add_argument("--persona", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", default="framecull-pro-convnext-persona-v1")
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    student_ckpt = torch.load(args.student, map_location="cpu")
    persona_ckpt = torch.load(args.persona, map_location="cpu")

    student = MultiHeadStudent(
        student_ckpt["backbone"],
        clip_dim=student_ckpt["clip_dim"],
        dino_dim=int(student_ckpt.get("dino_dim") or 0),
        pretrained=False,
        input_size=student_ckpt["input_size"],
    )
    student.load_state_dict(student_ckpt["model"])
    persona = PersonaHead(student.feat_dim)
    persona.load_state_dict(persona_ckpt["persona_head"])

    model = ProExportModel(student, persona).eval()
    for p in model.parameters():
        p.requires_grad_(False)

    fp32_path = os.path.join(args.out, "model.onnx")
    dummy = torch.randn(2, 3, student_ckpt["input_size"], student_ckpt["input_size"])
    torch.onnx.export(
        model,
        dummy,
        fp32_path,
        input_names=["pixel_values"],
        output_names=["aesthetic", "scene_logits", "persona"],
        dynamic_axes={
            "pixel_values": {0: "batch"},
            "aesthetic": {0: "batch"},
            "scene_logits": {0: "batch"},
            "persona": {0: "batch"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
        external_data=False,
        dynamo=False,
    )
    # Some PyTorch builds still emit external data by default. Re-save as a
    # single-file model so ORT quantization can load weights without side files.
    model_proto = onnx.load(fp32_path, load_external_data=True)
    onnx.save_model(model_proto, fp32_path, save_as_external_data=False)
    data_sidecar = fp32_path + ".data"
    if os.path.exists(data_sidecar):
        os.remove(data_sidecar)
    onnx.checker.check_model(onnx.load(fp32_path))
    fp32_validate = validate_onnx(fp32_path)

    int8_path = os.path.join(args.out, "model.int8.onnx")
    quantized, quant_error = maybe_quantize(fp32_path, int8_path)
    int8_validate = validate_onnx(int8_path) if quantized else None

    manifest = {
        "schemaVersion": 1,
        "backboneVersion": args.name,
        "model": "model.onnx",
        "sha256": sha256(fp32_path),
        "inputName": "pixel_values",
        "inputResolution": int(student_ckpt["input_size"]),
        "channels": 3,
        "normalize": {
            "mean": [0.485, 0.456, 0.406],
            "std": [0.229, 0.224, 0.225],
        },
        "heads": [
            {"name": "aesthetic", "output": "aesthetic", "kind": "scalar01"},
            {
                "name": "scene",
                "output": "scene_logits",
                "kind": "classifier",
                "labels": ["outdoor_portrait", "indoor_portrait", "scenery", "other"],
            },
            {"name": "persona", "output": "persona", "kind": "scalar01"},
        ],
        "labNotes": {
            "sceneHead": "placeholder logits from semantic embedding slice; not production scene routing",
            "labelPolicy": persona_ckpt.get("label_policy"),
            "valMetrics": persona_ckpt.get("val_metrics"),
            "allMetrics": persona_ckpt.get("all_metrics"),
            "ratingSrcc": persona_ckpt.get("rating_srcc"),
        },
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    if quantized:
        int8_manifest = dict(manifest)
        int8_manifest["model"] = "model.int8.onnx"
        int8_manifest["sha256"] = sha256(int8_path)
        int8_manifest["backboneVersion"] = f"{args.name}-int8-linear"
        int8_manifest["labNotes"] = dict(manifest["labNotes"])
        int8_manifest["labNotes"]["quantization"] = quant_error
        with open(os.path.join(args.out, "manifest.int8.json"), "w", encoding="utf-8") as f:
            json.dump(int8_manifest, f, ensure_ascii=False, indent=2)

    report = {
        "fp32": {
            "path": fp32_path,
            "sha256": manifest["sha256"],
            "bytes": os.path.getsize(fp32_path),
            "validation": fp32_validate,
        },
        "int8": {
            "path": int8_path if quantized else None,
            "sha256": sha256(int8_path) if quantized else None,
            "bytes": os.path.getsize(int8_path) if quantized else None,
            "validation": int8_validate,
            "quantization": quant_error,
        },
    }
    with open(os.path.join(args.out, "export-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("==EXPORT_DONE==", json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
