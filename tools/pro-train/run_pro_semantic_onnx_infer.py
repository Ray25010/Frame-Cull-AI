#!/usr/bin/env python
"""Run a Pro Semantic ONNX manifest over an eval audit and emit pro-infer JSON.

This is a server/lab fallback for machines that have Python ONNX Runtime but do
not have the Rust toolchain needed to build src-tauri/src/bin/pro-infer-bench.
It mirrors the ProHeadScores JSON shape consumed by bench-pro-semantic-student.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from PIL import Image


DECODABLE_EXTS = {".jpg", ".jpeg", ".png"}
PATH_KEYS = ("studentPreviewPath", "previewPath", "imagePath", "importPath")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--preview-dir")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--provider", default="auto", help="auto, CUDAExecutionProvider, CPUExecutionProvider, ...")
    return parser.parse_args()


def read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def manifest_model_path(manifest_path: Path, manifest: dict[str, Any]) -> Path:
    model = Path(str(manifest["model"]))
    return model if model.is_absolute() else manifest_path.parent / model


def choose_session(model_path: Path, provider: str) -> tuple[ort.InferenceSession, str, list[str], float]:
    available = set(ort.get_available_providers())
    if provider and provider != "auto":
        candidates = [provider]
    else:
        candidates = [
            "CUDAExecutionProvider",
            "DmlExecutionProvider",
            "CPUExecutionProvider",
        ]
    chain: list[str] = []
    started = time.perf_counter()
    last_error: Exception | None = None
    for candidate in candidates:
        if candidate not in available:
            chain.append(f"{candidate}: unavailable")
            continue
        try:
            sess = ort.InferenceSession(str(model_path), providers=[candidate])
            warmup_ms = (time.perf_counter() - started) * 1000.0
            active = sess.get_providers()[0] if sess.get_providers() else candidate
            chain.append(f"{candidate}: ok")
            return sess, active, chain, warmup_ms
        except Exception as exc:  # pragma: no cover - provider-dependent.
            last_error = exc
            chain.append(f"{candidate}: {exc}")
    raise RuntimeError(f"Unable to create ONNX Runtime session: {last_error}; chain={chain}")


def pick_image_path(summary: dict[str, Any], preview_dir: Path | None) -> str:
    for key in PATH_KEYS:
        value = str(summary.get(key) or "").strip()
        if value:
            path = Path(value)
            if path.suffix.lower() in DECODABLE_EXTS and path.exists():
                return str(path)

    file_name = str(summary.get("fileName") or "")
    photo_id = str(summary.get("id") or summary.get("photoId") or "")
    if preview_dir:
        candidates: list[Path] = []
        if file_name:
            candidates.append(preview_dir / file_name)
        for ext in (".jpg", ".jpeg", ".png"):
            candidates.append(preview_dir / f"{photo_id}{ext}")
        for candidate in candidates:
            if candidate.exists():
                return str(candidate)

    source = str(summary.get("sourceName") or "")
    source_path = Path(source)
    if source_path.suffix.lower() in DECODABLE_EXTS:
        return source
    for ext in (".jpg", ".jpeg"):
        candidate = source_path.with_suffix(ext)
        if candidate.exists():
            return str(candidate)
    return source


def preprocess(path: str, resolution: int, mean: list[float], std: list[float]) -> np.ndarray:
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        resized = rgb.resize((resolution, resolution), Image.Resampling.BICUBIC)
    arr = np.asarray(resized, dtype=np.float32) / 255.0
    arr = (arr - np.asarray(mean, dtype=np.float32)) / np.asarray(std, dtype=np.float32)
    return np.transpose(arr, (2, 0, 1))


def assign_outputs(rows: list[dict[str, Any]], row_indices: list[int], output_names: list[str], outputs: list[np.ndarray], heads: list[dict[str, Any]]) -> None:
    by_name = {name: value for name, value in zip(output_names, outputs)}
    has_false_face_risk_head = any(str(head.get("name") or "") in {"false_face_risk", "falseFaceRisk"} for head in heads)
    for head in heads:
        name = str(head.get("name") or "")
        output_name = str(head.get("output") or "")
        kind = str(head.get("kind") or "")
        values = by_name.get(output_name)
        if values is None:
            continue
        for local_index, row_index in enumerate(row_indices):
            slice_value = np.asarray(values[local_index])
            if kind == "scalar01":
                value = float(np.clip(slice_value.reshape(-1)[0], 0.0, 1.0))
                assign_scalar(rows[row_index], name, value)
            elif kind == "classifier":
                labels = head.get("labels") or []
                best, confidence = argmax_softmax(slice_value.reshape(-1))
                rows[row_index]["sceneLabel"] = str(labels[best]) if best < len(labels) else f"class_{best}"
                rows[row_index]["sceneConfidence"] = confidence
    if not has_false_face_risk_head:
        for row_index in row_indices:
            row = rows[row_index]
            if row.get("falseFaceRisk") is None and row.get("faceValidityScore") is not None:
                row["falseFaceRisk"] = float(np.clip(1.0 - float(row["faceValidityScore"]), 0.0, 1.0))


def assign_scalar(row: dict[str, Any], name: str, value: float) -> None:
    if name == "aesthetic":
        row["aesthetic"] = value
    elif name == "persona":
        row["personaScore"] = value
    elif name in {"semantic_keep", "semanticKeepScore"}:
        row["semanticKeepScore"] = value
    elif name in {"face_validity", "faceValidityScore"}:
        row["faceValidityScore"] = value
    elif name in {"composition", "compositionScore"}:
        row["compositionScore"] = value
    elif name in {"moment", "momentScore"}:
        row["momentScore"] = value
    elif name in {"lighting", "lighting_mood", "lightingMoodScore"}:
        row["lightingMoodScore"] = value
    elif name in {"false_face_risk", "falseFaceRisk"}:
        row["falseFaceRisk"] = value


def argmax_softmax(values: np.ndarray) -> tuple[int, float]:
    if values.size == 0:
        return 0, 0.0
    max_value = float(np.max(values))
    exps = np.exp(values.astype(np.float32) - max_value)
    total = float(np.sum(exps))
    best = int(np.argmax(values))
    confidence = float(exps[best] / total) if total > 0 and math.isfinite(total) else 0.0
    return best, confidence


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest)
    manifest = read_json(manifest_path)
    audit = read_json(args.audit)
    model_path = manifest_model_path(manifest_path, manifest)
    sess, active_ep, chain, warmup_ms = choose_session(model_path, args.provider)

    resolution = int(manifest.get("inputResolution") or 384)
    normalize = manifest.get("normalize") or {}
    mean = [float(value) for value in normalize.get("mean", [0.485, 0.456, 0.406])]
    std = [float(value) for value in normalize.get("std", [0.229, 0.224, 0.225])]
    input_name = str(manifest.get("inputName") or sess.get_inputs()[0].name)
    output_names = [item.name for item in sess.get_outputs()]
    heads = list(manifest.get("heads") or [])
    preview_dir = Path(args.preview_dir) if args.preview_dir else None

    summaries = list(audit.get("photoSummaries") or [])
    if args.limit:
        summaries = summaries[: args.limit]

    rows: list[dict[str, Any]] = []
    arrays: list[np.ndarray] = []
    array_indices: list[int] = []
    started = time.perf_counter()

    def flush() -> None:
        nonlocal arrays, array_indices
        if not arrays:
            return
        batch = np.stack(arrays, axis=0).astype("float32")
        outputs = sess.run(None, {input_name: batch})
        assign_outputs(rows, array_indices, output_names, outputs, heads)
        arrays = []
        array_indices = []

    for summary in summaries:
        photo_id = str(summary.get("id") or summary.get("photoId") or "")
        image_path = pick_image_path(summary, preview_dir)
        row = {
            "photoId": photo_id,
            "imagePath": image_path,
            "aesthetic": None,
            "personaScore": None,
            "sceneLabel": None,
            "sceneConfidence": None,
            "semanticKeepScore": None,
            "faceValidityScore": None,
            "compositionScore": None,
            "momentScore": None,
            "lightingMoodScore": None,
            "falseFaceRisk": None,
            "error": None,
        }
        rows.append(row)
        try:
            arrays.append(preprocess(image_path, resolution, mean, std))
            array_indices.append(len(rows) - 1)
        except Exception as exc:
            row["error"] = str(exc)
        if len(arrays) >= max(1, int(args.batch_size)):
            flush()
    flush()

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    output = {
        "manifestPath": str(manifest_path),
        "activeEp": active_ep,
        "epFallbackChain": chain,
        "backboneVersion": manifest.get("backboneVersion") or manifest.get("backbone") or "unknown",
        "warmupMs": warmup_ms,
        "batchSize": int(args.batch_size),
        "count": len(rows),
        "elapsedMs": elapsed_ms,
        "meanPerImageMs": elapsed_ms / len(rows) if rows else 0.0,
        "results": rows,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[pro-semantic-onnx-infer] rows={len(rows)} activeEp={active_ep} -> {output_path}")


if __name__ == "__main__":
    main()
