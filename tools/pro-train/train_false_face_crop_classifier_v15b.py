#!/usr/bin/env python3
"""Train and evaluate the v15B independent false-face crop classifier.

Route B is deliberately decoupled from the semantic student.  It trains a small
crop classifier on teacher face-region verdicts:

- label 1: face-like crop is not a real human face
- label 0: real human face crop

The 84-image independent holdout is only scored after training.  It is never
used for split selection, threshold fitting, or tuning.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.machinery
import json
import math
import os
import random
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image, ImageFile
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

import timm
from train_distill_backbone import IMAGENET_MEAN, IMAGENET_STD

ImageFile.LOAD_TRUNCATED_IMAGES = True


DEFAULT_LAB = Path("/data/FrameCullModelLab")
DEFAULT_TEACHER = DEFAULT_LAB / "features/semantic-teacher/semantic-teacher-v1.3-five-mountain-v14.jsonl"
DEFAULT_HOLDOUT = DEFAULT_LAB / "outputs/semantic-false-face-diagnosis/v13-eval/independent-false-face-set.csv"
DEFAULT_HOLDOUT_PREVIEWS = DEFAULT_LAB / "outputs/semantic-false-face-diagnosis/v13-eval/upload-previews-384"
DEFAULT_FULL_GUARD = DEFAULT_LAB / "outputs/semantic-false-face-diagnosis/v15-replay/guard-full-scores.json"
DEFAULT_V15_HOLDOUT_RAW = DEFAULT_LAB / "outputs/semantic-false-face-diagnosis/v13-eval/face-presence-yunet-raw.json"
DEFAULT_YUNET = DEFAULT_LAB / "workspace-current/face_detection_yunet_2023mar.onnx"
DEFAULT_OUT = DEFAULT_LAB / "outputs/semantic-false-face-diagnosis/v15b"
DEFAULT_WORKSPACE = DEFAULT_LAB / "workspace"

DATASET_PREVIEW_DIRS = {
    "audit3groups": DEFAULT_LAB / "incoming/raw-audit-previews",
    "camera": DEFAULT_LAB / "incoming/camera-previews-384",
    "five_mountain": DEFAULT_LAB / "incoming/five-mountain-previews-384",
}

GATE_THRESHOLD = 0.34
GUARD_THRESHOLD = 0.5


@dataclass
class CropSample:
    sample_id: str
    photo_id: str
    dataset: str
    image_path: str
    region: list[float]
    label: int
    scene_type: str
    confidence: float
    evidence: str


class CropDataset(Dataset):
    def __init__(self, samples: list[CropSample], input_size: int, augment: bool):
        self.samples = samples
        self.input_size = input_size
        self.augment = augment

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int):
        sample = self.samples[index]
        tensor = load_crop_tensor(sample.image_path, sample.region, self.input_size, context_pad=0.22)
        if self.augment:
            if torch.rand(1).item() < 0.5:
                tensor = torch.flip(tensor, dims=[2])
            if torch.rand(1).item() < 0.18:
                jitter = 1.0 + (torch.rand(1).item() - 0.5) * 0.16
                tensor = torch.clamp(tensor * jitter, 0.0, 1.0)
        return normalize_tensor(tensor), torch.tensor(float(sample.label), dtype=torch.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description="FrameCull false-face route B crop classifier v15B")
    parser.add_argument("--teacher", type=Path, default=DEFAULT_TEACHER)
    parser.add_argument("--holdout-csv", type=Path, default=DEFAULT_HOLDOUT)
    parser.add_argument("--holdout-preview-dir", type=Path, default=DEFAULT_HOLDOUT_PREVIEWS)
    parser.add_argument("--full-guard", type=Path, default=DEFAULT_FULL_GUARD)
    parser.add_argument("--v15-holdout-yunet", type=Path, default=DEFAULT_V15_HOLDOUT_RAW)
    parser.add_argument("--yunet-model", type=Path, default=DEFAULT_YUNET)
    parser.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--model-name", default="mobilenetv3_small_100")
    parser.add_argument("--pretrained", action="store_true", help="Try to load timm pretrained weights. Default is off to avoid network stalls.")
    parser.add_argument("--input-size", type=int, default=160)
    parser.add_argument("--epochs", type=int, default=18)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--seed", type=int, default=1502)
    parser.add_argument("--gate-threshold", type=float, default=GATE_THRESHOLD)
    parser.add_argument("--guard-threshold", type=float, default=GUARD_THRESHOLD)
    parser.add_argument("--candidate-limit", type=int, default=8)
    parser.add_argument("--smoke-limit", type=int, default=0)
    parser.add_argument("--holdout-limit", type=int, default=0)
    parser.add_argument("--full-limit", type=int, default=0)
    args = parser.parse_args()

    started = time.time()
    args.out.mkdir(parents=True, exist_ok=True)
    set_seed(args.seed)

    holdout_rows = read_holdout(args.holdout_csv)
    holdout_ids = {norm_id(row["photoId"]) for row in holdout_rows}
    samples, manifest = build_crop_samples(args.teacher, holdout_ids, args.smoke_limit)
    if not samples:
        raise SystemExit("no crop samples found")

    train_samples, val_samples = split_by_photo(samples, seed=args.seed)
    model, pretrained = build_model(args.model_name, args.pretrained)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)

    train_loader = build_loader(train_samples, args.input_size, args.batch, args.workers, train=True)
    val_loader = build_loader(val_samples, args.input_size, args.batch, args.workers, train=False)

    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, args.epochs))
    criterion = nn.BCEWithLogitsLoss()

    best_auc = -1.0
    best_epoch = 0
    best_path = args.out / "crop-classifier-v15b.pt"
    history: list[dict[str, Any]] = []
    for epoch in range(1, args.epochs + 1):
        train_loss = train_epoch(model, train_loader, optimizer, criterion, device)
        val_metrics = evaluate_loader(model, val_loader, device)
        scheduler.step()
        row = {"epoch": epoch, "trainLoss": train_loss, **val_metrics}
        history.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
        if val_metrics["auc"] > best_auc:
            best_auc = val_metrics["auc"]
            best_epoch = epoch
            torch.save(
                {
                    "schemaVersion": "framecull-false-face-crop-classifier-v15b",
                    "modelName": args.model_name,
                    "inputSize": args.input_size,
                    "stateDict": model.state_dict(),
                    "pretrained": pretrained,
                    "gateThreshold": args.gate_threshold,
                    "guardThreshold": args.guard_threshold,
                    "labelDefinition": "1=false-face-like-not-real-human-face, 0=real-human-face",
                },
                best_path,
            )

    checkpoint = torch.load(best_path, map_location=device)
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()

    dataset_manifest = {
        **manifest,
        "schemaVersion": "framecull-false-face-v15b-crop-dataset-manifest-v1",
        "createdAt": iso_now(),
        "teacherPath": str(args.teacher),
        "teacherSha256": file_sha256(args.teacher),
        "holdoutCsv": str(args.holdout_csv),
        "holdoutCount": len(holdout_ids),
        "holdoutIntersectionCount": manifest["holdoutIntersectionCount"],
        "trainSamples": summarize_samples(train_samples),
        "valSamples": summarize_samples(val_samples),
        "labelDefinition": {
            "positive": "teacher faceRegionVerdicts.isRealHumanFace=false, face-like but not a real human face",
            "negative": "teacher faceRegionVerdicts.isRealHumanFace=true, real human face",
        },
    }
    write_json(args.out / "crop-dataset-manifest.json", dataset_manifest)

    training_report = {
        "schemaVersion": "framecull-false-face-v15b-training-report-v1",
        "createdAt": iso_now(),
        "route": "B: independent crop classifier, decoupled from semantic student",
        "semanticStudentChanged": False,
        "teacherPromptChanged": False,
        "holdoutUsedForTrainingTuningOrThresholdFitting": False,
        "holdoutIntersectionCount": manifest["holdoutIntersectionCount"],
        "model": {
            "modelName": args.model_name,
            "pretrained": pretrained,
            "inputSize": args.input_size,
            "checkpoint": str(best_path),
            "checkpointSha256": file_sha256(best_path),
            "device": str(device),
        },
        "training": {
            "epochs": args.epochs,
            "batch": args.batch,
            "workers": args.workers,
            "bestEpoch": best_epoch,
            "bestValAuc": best_auc,
            "history": history,
            "elapsedS": time.time() - started,
        },
        "dataset": dataset_manifest,
    }
    write_json(args.out / "training-report-v15b.json", training_report)

    print("[v15b] scoring holdout", flush=True)
    holdout_scores = score_holdout(
        model,
        device,
        holdout_rows[: args.holdout_limit] if args.holdout_limit else holdout_rows,
        args.holdout_preview_dir,
        args.v15_holdout_yunet,
        args.yunet_model,
        args.input_size,
        args.gate_threshold,
        args.guard_threshold,
        args.candidate_limit,
    )
    write_csv(args.out / "v15b-holdout-scores.csv", holdout_scores)
    holdout_metrics = evaluate_scores(holdout_scores, "label", "selectedV15BRisk", args.guard_threshold)

    print("[v15b] scoring full replay", flush=True)
    full_payload, full_rows = score_full_replay(
        model,
        device,
        args.full_guard,
        args.yunet_model,
        args.input_size,
        args.gate_threshold,
        args.guard_threshold,
        args.candidate_limit,
        args.full_limit,
    )
    write_json(args.out / "guard-full-scores.json", full_payload)
    write_csv(args.out / "guard-full-scores.csv", full_rows)
    write_json(args.out / "upstream-gate-v2-coverage.json", full_payload["coverage"])

    holdout_summary = {
        "schemaVersion": "framecull-false-face-v15b-holdout-summary-v1",
        "createdAt": iso_now(),
        "threshold": args.guard_threshold,
        "gateThreshold": args.gate_threshold,
        "metrics": holdout_metrics,
        "counts": {
            "total": len(holdout_scores),
            "falseFacePositive": sum(1 for row in holdout_scores if int(row["label"]) == 1),
            "realFaceControl": sum(1 for row in holdout_scores if int(row["label"]) == 0),
        },
        "holdoutUsedForTrainingTuningOrThresholdFitting": False,
    }
    write_json(args.out / "holdout-summary-v15b.json", holdout_summary)

    report = write_report_markdown(
        out_dir=args.out,
        dataset_manifest=dataset_manifest,
        training_report=training_report,
        holdout_summary=holdout_summary,
        full_coverage=full_payload["coverage"],
    )
    (args.out / "false-face-v15b-report.md").write_text(report, encoding="utf-8")

    print(
        json.dumps(
            {
                "out": str(args.out),
                "bestValAuc": best_auc,
                "holdoutAuc": holdout_metrics["auc"],
                "holdoutTprAt05": holdout_metrics["tprAtThreshold"],
                "holdoutFprAt05": holdout_metrics["fprAtThreshold"],
                "fullGateRate": full_payload["coverage"]["v15b"]["upstreamGateTriggerRate"],
                "fullGuardRate": full_payload["coverage"]["v15b"]["guardTriggerRate"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )


def build_crop_samples(teacher_path: Path, holdout_ids: set[str], smoke_limit: int) -> tuple[list[CropSample], dict[str, Any]]:
    samples: list[CropSample] = []
    dataset_counts: Counter[str] = Counter()
    scene_counts: Counter[str] = Counter()
    label_counts: Counter[str] = Counter()
    holdout_intersections: list[str] = []
    missing_images = 0
    region_count = 0
    record_count = 0
    with_region_records = 0

    with teacher_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            record_count += 1
            record = json.loads(line)
            photo_id = str(record.get("photoId") or record.get("stem") or "")
            norm = norm_id(photo_id)
            if norm in holdout_ids:
                holdout_intersections.append(photo_id)
                continue
            verdicts = record.get("faceRegionVerdicts") or []
            if not isinstance(verdicts, list) or not verdicts:
                continue
            with_region_records += 1
            image_path = resolve_teacher_image_path(record)
            if not image_path or not Path(image_path).exists():
                missing_images += len(verdicts)
                continue
            for verdict_index, verdict in enumerate(verdicts):
                if not isinstance(verdict, dict):
                    continue
                region = verdict.get("region")
                if not valid_region(region):
                    continue
                is_real = verdict.get("isRealHumanFace")
                if not isinstance(is_real, bool):
                    continue
                label = 0 if is_real else 1
                dataset = str(record.get("dataset") or "unknown")
                scene_type = str(record.get("sceneType") or "unknown")
                sample = CropSample(
                    sample_id=f"{photo_id}#{verdict_index}",
                    photo_id=photo_id,
                    dataset=dataset,
                    image_path=str(image_path),
                    region=[float(v) for v in region],
                    label=label,
                    scene_type=scene_type,
                    confidence=float(verdict.get("confidence") or 0.0),
                    evidence=str(verdict.get("evidence") or ""),
                )
                samples.append(sample)
                dataset_counts[dataset] += 1
                scene_counts[scene_type] += 1
                label_counts["falseFace" if label else "realFace"] += 1
                region_count += 1
                if smoke_limit and len(samples) >= smoke_limit:
                    break
            if smoke_limit and len(samples) >= smoke_limit:
                break

    if holdout_intersections:
        raise SystemExit(f"holdout photoId leaked into crop training data: {holdout_intersections[:20]}")

    manifest = {
        "totalTeacherRecordsRead": record_count,
        "recordsWithFaceRegionVerdicts": with_region_records,
        "totalUsableCropSamples": len(samples),
        "totalTeacherRegionCandidates": region_count,
        "missingImageRegionCount": missing_images,
        "holdoutIntersectionCount": len(holdout_intersections),
        "holdoutIntersectionPhotoIds": holdout_intersections[:50],
        "datasetCounts": dict(dataset_counts),
        "sceneCounts": dict(scene_counts),
        "labelCounts": dict(label_counts),
    }
    return samples, manifest


def resolve_teacher_image_path(record: dict[str, Any]) -> str | None:
    for key in ("studentPreviewPath", "imagePath", "previewPath"):
        raw = record.get(key)
        if raw and Path(str(raw)).exists():
            return str(raw)
    dataset = str(record.get("dataset") or "")
    photo_id = str(record.get("photoId") or record.get("stem") or "")
    stem = Path(photo_id).stem
    base = DATASET_PREVIEW_DIRS.get(dataset)
    if base:
        for candidate in (base / f"{stem}.jpg", base / f"{stem}.JPG", base / f"{stem.lower()}.jpg", base / f"{stem.upper()}.jpg"):
            if candidate.exists():
                return str(candidate)
    return None


def split_by_photo(samples: list[CropSample], seed: int) -> tuple[list[CropSample], list[CropSample]]:
    by_photo: dict[str, list[CropSample]] = defaultdict(list)
    for sample in samples:
        by_photo[norm_id(sample.photo_id)].append(sample)
    photos = list(by_photo.items())
    rng = random.Random(seed)
    rng.shuffle(photos)
    val_target = max(1, round(len(photos) * 0.15))
    val_photo_ids = {photo_id for photo_id, _ in photos[:val_target]}
    train = [sample for sample in samples if norm_id(sample.photo_id) not in val_photo_ids]
    val = [sample for sample in samples if norm_id(sample.photo_id) in val_photo_ids]
    if len({sample.label for sample in val}) < 2:
        raise SystemExit("validation split has only one class; cannot evaluate AUC")
    return train, val


def build_model(model_name: str, pretrained_requested: bool) -> tuple[nn.Module, bool]:
    if not pretrained_requested:
        return timm.create_model(model_name, pretrained=False, num_classes=1), False
    try:
        return timm.create_model(model_name, pretrained=True, num_classes=1), True
    except Exception as error:
        print(f"[v15b][warn] pretrained {model_name} unavailable: {error}; using random init", flush=True)
        return timm.create_model(model_name, pretrained=False, num_classes=1), False


def build_loader(samples: list[CropSample], input_size: int, batch: int, workers: int, train: bool) -> DataLoader:
    dataset = CropDataset(samples, input_size=input_size, augment=train)
    if train:
        counts = Counter(sample.label for sample in samples)
        weights = [1.0 / max(1, counts[sample.label]) for sample in samples]
        sampler = WeightedRandomSampler(weights, num_samples=len(samples), replacement=True)
        return DataLoader(dataset, batch_size=batch, sampler=sampler, num_workers=workers, pin_memory=True)
    return DataLoader(dataset, batch_size=batch, shuffle=False, num_workers=workers, pin_memory=True)


def train_epoch(model: nn.Module, loader: DataLoader, optimizer: torch.optim.Optimizer, criterion: nn.Module, device: torch.device) -> float:
    model.train()
    total_loss = 0.0
    total = 0
    for images, labels in loader:
        images = images.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)
        optimizer.zero_grad(set_to_none=True)
        logits = model(images).flatten()
        loss = criterion(logits, labels)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
        optimizer.step()
        total_loss += float(loss.item()) * int(labels.numel())
        total += int(labels.numel())
    return total_loss / max(1, total)


@torch.no_grad()
def evaluate_loader(model: nn.Module, loader: DataLoader, device: torch.device) -> dict[str, float]:
    model.eval()
    labels: list[int] = []
    scores: list[float] = []
    for images, batch_labels in loader:
        images = images.to(device, non_blocking=True)
        logits = model(images).flatten()
        probs = torch.sigmoid(logits).detach().cpu().numpy().tolist()
        scores.extend(float(value) for value in probs)
        labels.extend(int(value) for value in batch_labels.numpy().tolist())
    return binary_metrics(labels, scores, threshold=GUARD_THRESHOLD)


def score_holdout(
    model: nn.Module,
    device: torch.device,
    holdout_rows: list[dict[str, str]],
    preview_dir: Path,
    v15_yunet_raw: Path,
    yunet_model: Path,
    input_size: int,
    gate_threshold: float,
    guard_threshold: float,
    candidate_limit: int,
) -> list[dict[str, Any]]:
    detector = build_yunet(yunet_model)
    v15_by_id = {}
    if v15_yunet_raw.exists():
        payload = json.loads(v15_yunet_raw.read_text(encoding="utf-8"))
        v15_by_id = {norm_id(row.get("photoId")): row for row in payload.get("results", [])}

    rows: list[dict[str, Any]] = []
    for row in holdout_rows:
        photo_id = row["photoId"]
        image_path = preview_dir / f"{Path(photo_id).stem}.jpg"
        if not image_path.exists():
            image_path = preview_dir / f"{Path(photo_id).stem}.JPG"
        detected = detect_image_all_candidates(detector, image_path)
        score = score_candidate_boxes(model, device, image_path, detected["boxes"], input_size, candidate_limit)
        max_face = detected["maxFacePresence"]
        upstream = max_face >= gate_threshold and detected["faceCount"] > 0
        risk = score["maxFalseFaceRisk"] if upstream else 0.0
        label = 1 if row.get("sampleRole") == "false_face_positive" else 0
        v15 = v15_by_id.get(norm_id(photo_id), {})
        rows.append(
            {
                "photoId": photo_id,
                "sampleRole": row.get("sampleRole", ""),
                "label": label,
                "hasRealHumanFace": row.get("hasRealHumanFace", ""),
                "scene": row.get("scene", ""),
                "illusionReason": row.get("illusionReason", ""),
                "imagePath": str(image_path),
                "maxFacePresence": max_face,
                "faceCount": detected["faceCount"],
                "candidateCount": len(detected["boxes"]),
                "upstreamGateTriggered": upstream,
                "selectedV15BRisk": risk,
                "cropTrueFaceProb": score["maxTrueFaceProb"],
                "maxCropFalseFaceRisk": score["maxFalseFaceRisk"],
                "guardTriggered": risk >= guard_threshold,
                "v15SelectedRisk": v15.get("selectedV15Risk", ""),
                "v15ReliableFacePresence": v15.get("reliableFacePresence", ""),
                "v15MaxFacePresence": v15.get("maxFacePresence", ""),
                "topBox": json.dumps(score["topBox"], ensure_ascii=False) if score["topBox"] else "",
            }
        )
    return rows


def score_full_replay(
    model: nn.Module,
    device: torch.device,
    full_guard_path: Path,
    yunet_model: Path,
    input_size: int,
    gate_threshold: float,
    guard_threshold: float,
    candidate_limit: int,
    full_limit: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    v15_payload = json.loads(full_guard_path.read_text(encoding="utf-8"))
    detector = build_yunet(yunet_model)
    rows: list[dict[str, Any]] = []
    started = time.time()
    source_rows = v15_payload.get("results", [])
    if full_limit:
        source_rows = source_rows[:full_limit]
    for index, source in enumerate(source_rows, start=1):
        image_path = Path(str(source.get("imagePath") or ""))
        try:
            detected = detect_image_all_candidates(detector, image_path)
            score = score_candidate_boxes(model, device, image_path, detected["boxes"], input_size, candidate_limit)
            max_face = detected["maxFacePresence"]
            upstream = max_face >= gate_threshold and detected["faceCount"] > 0
            risk = score["maxFalseFaceRisk"] if upstream else 0.0
            row = {
                **source,
                "v15MaxFacePresence": source.get("maxFacePresence"),
                "v15ReliableFacePresence": source.get("reliableFacePresence"),
                "v15ConflictRisk": source.get("conflictRisk"),
                "maxFacePresence": max_face,
                "reliableFacePresence": score["maxTrueFaceProb"],
                "faceCount": detected["faceCount"],
                "reliableFaceCount": score["candidateCount"],
                "candidateCount": len(detected["boxes"]),
                "selectedV15Risk": risk,
                "selectedV15BRisk": risk,
                "conflictRisk": risk,
                "softConflictRisk": math.sqrt(max(0.0, max_face) * max(0.0, risk)),
                "upstreamGateTriggered": upstream,
                "guardTriggered": risk >= guard_threshold,
                "boxes": score["scoredBoxes"],
                "error": None,
            }
        except Exception as error:
            row = {
                **source,
                "selectedV15BRisk": 0.0,
                "selectedV15Risk": 0.0,
                "conflictRisk": 0.0,
                "upstreamGateTriggered": False,
                "guardTriggered": False,
                "candidateCount": 0,
                "error": str(error),
            }
        rows.append(row)
        if index % 250 == 0:
            print(f"[v15b] full score {index}/{len(source_rows)}", flush=True)

    coverage = build_full_coverage(v15_payload, rows, gate_threshold, guard_threshold, time.time() - started)
    payload = {
        "schemaVersion": "framecull-v15b-false-face-crop-guard-full-scores-v1",
        "createdAt": iso_now(),
        "route": "B: independent crop classifier",
        "sourceV15Guard": str(full_guard_path),
        "gateThreshold": gate_threshold,
        "guardThreshold": guard_threshold,
        "runtime": {
            "device": str(device),
            "candidateSource": "YuNet all merged boxes scored by independent crop classifier",
        },
        "count": len(rows),
        "coverage": coverage,
        "summary": coverage["v15b"],
        "results": rows,
    }
    return payload, rows


def build_full_coverage(v15_payload: dict[str, Any], rows: list[dict[str, Any]], gate_threshold: float, guard_threshold: float, elapsed_s: float) -> dict[str, Any]:
    total = len(rows)
    v15_summary = v15_payload.get("summary", {})
    gate = [row for row in rows if row.get("upstreamGateTriggered")]
    guard = [row for row in rows if row.get("guardTriggered")]
    teacher_known = [row for row in rows if isinstance(row.get("teacherHasRealHumanFace"), bool)]
    teacher_relevant = [
        row
        for row in teacher_known
        if row.get("teacherHasRealHumanFace") is True or float_or(row.get("teacherFalseFaceRisk"), 0.0) >= guard_threshold
    ]
    guard_false = [
        row
        for row in guard
        if row.get("teacherHasRealHumanFace") is False and float_or(row.get("teacherFalseFaceRisk"), 0.0) >= guard_threshold
    ]
    guard_real = [row for row in guard if row.get("teacherHasRealHumanFace") is True]
    return {
        "schemaVersion": "framecull-v15b-upstream-gate-v2-coverage-v1",
        "createdAt": iso_now(),
        "v15Reference": {
            "upstreamGate": "maxFacePresence >= 0.08",
            "upstreamGateTriggered": v15_summary.get("upstreamGateTriggered"),
            "upstreamGateTriggerRate": v15_summary.get("upstreamGateTriggerRate"),
            "guardTriggered": v15_summary.get("guardTriggered"),
            "guardTriggerRate": v15_summary.get("guardTriggerRate"),
            "teacherProxyGuardRealFaceCount": v15_summary.get("teacherProxyGuardRealFaceCount"),
            "teacherProxyGuardFalseFaceHighRiskCount": v15_summary.get("teacherProxyGuardFalseFaceHighRiskCount"),
        },
        "v15bGateDefinition": {
            "upstreamGate": f"YuNet max merged candidate confidence >= {gate_threshold}",
            "guard": f"max crop false-face risk >= {guard_threshold}",
            "thresholdTunedOn84Holdout": False,
        },
        "v15b": {
            "total": total,
            "errors": sum(1 for row in rows if row.get("error")),
            "upstreamGateTriggered": len(gate),
            "upstreamGateTriggerRate": safe_div(len(gate), total),
            "guardTriggered": len(guard),
            "guardTriggerRate": safe_div(len(guard), total),
            "teacherProxyKnown": len(teacher_known),
            "teacherProxyFaceRelevant": len(teacher_relevant),
            "teacherProxyGatePrecision": safe_div(sum(1 for row in gate if row in teacher_relevant), len(gate)),
            "teacherProxyGateRecall": safe_div(sum(1 for row in teacher_relevant if row.get("upstreamGateTriggered")), len(teacher_relevant)),
            "teacherProxyGuardRealFaceCount": len(guard_real),
            "teacherProxyGuardFalseFaceHighRiskCount": len(guard_false),
            "teacherProxyGuardFalseFacePrecision": safe_div(len(guard_false), len(guard)),
            "meanElapsedMs": safe_div(elapsed_s * 1000, total),
        },
    }


def build_yunet(model_path: Path) -> Any:
    detector = cv2.FaceDetectorYN_create(str(model_path), "", (640, 640), score_threshold=0.05, nms_threshold=0.3, top_k=5000)
    return detector


def load_probe_module() -> Any:
    candidates = [
        DEFAULT_WORKSPACE / "tools/ai-lab/probe-v15-full-yunet.py",
        DEFAULT_LAB / "workspace-current/tools/ai-lab/probe-v15-full-yunet.py",
        Path(__file__).resolve().parents[1] / "ai-lab/probe-v15-full-yunet.py",
    ]
    path = next((candidate for candidate in candidates if candidate.exists()), candidates[0])
    return importlib.machinery.SourceFileLoader("framecull_probe_v15_yunet", str(path)).load_module()


_PROBE: Any | None = None


def detect_image_all_candidates(detector: Any, image_path: Path) -> dict[str, Any]:
    global _PROBE
    if _PROBE is None:
        _PROBE = load_probe_module()
    image = cv2.imread(str(image_path))
    if image is None:
        raise FileNotFoundError(str(image_path))
    height, width = image.shape[:2]
    boxes = _PROBE.detect_candidates(detector, image, "full")
    enhanced_passes = 0
    if _PROBE.should_run_enhanced(boxes, width, height):
        for region in _PROBE.enhanced_regions(width, height):
            x, y, w, h, source = region
            crop = image[y : y + h, x : x + w]
            if crop.size == 0:
                continue
            enhanced_passes += 1
            for box in _PROBE.detect_candidates(detector, crop, source):
                box["x"] += x
                box["y"] += y
                box["keypoints"] = [{"x": point["x"] + x, "y": point["y"] + y} for point in box.get("keypoints", [])]
                boxes.append(_PROBE.clamp_box(box, width, height))
    merged = _PROBE.merge_boxes(boxes, 0.35)
    return {
        "width": width,
        "height": height,
        "maxFacePresence": max((float(box["confidence"]) for box in merged), default=0.0),
        "faceCount": len(merged),
        "enhancedPasses": enhanced_passes,
        "boxes": [_PROBE.round_box(box) for box in merged[:16]],
    }


@torch.no_grad()
def score_candidate_boxes(
    model: nn.Module,
    device: torch.device,
    image_path: Path,
    boxes: list[dict[str, Any]],
    input_size: int,
    candidate_limit: int,
) -> dict[str, Any]:
    selected = boxes[:candidate_limit]
    if not selected:
        return {"maxFalseFaceRisk": 0.0, "maxTrueFaceProb": 0.0, "candidateCount": 0, "topBox": None, "scoredBoxes": []}
    tensors = []
    for box in selected:
        region = box_to_region(box)
        tensors.append(normalize_tensor(load_crop_tensor(str(image_path), region, input_size, context_pad=0.28)))
    batch = torch.stack(tensors, dim=0).to(device)
    probs = torch.sigmoid(model(batch).flatten()).detach().cpu().numpy().tolist()
    scored = []
    for box, risk in zip(selected, probs):
        true_prob = 1.0 - float(risk)
        scored_box = {
            **box,
            "cropFalseFaceRisk": round(float(risk), 6),
            "cropTrueFaceProb": round(true_prob, 6),
        }
        scored.append(scored_box)
    top = max(scored, key=lambda item: float(item["cropFalseFaceRisk"]))
    return {
        "maxFalseFaceRisk": float(top["cropFalseFaceRisk"]),
        "maxTrueFaceProb": max(float(item["cropTrueFaceProb"]) for item in scored),
        "candidateCount": len(scored),
        "topBox": top,
        "scoredBoxes": scored,
    }


def load_crop_tensor(path: str, region: list[float], input_size: int, context_pad: float) -> torch.Tensor:
    try:
        image = Image.open(path).convert("RGB")
        width, height = image.size
        x1, y1, x2, y2 = region_to_pixels(region, width, height, context_pad)
        image = image.crop((x1, y1, x2, y2)).resize((input_size, input_size), Image.BILINEAR)
        arr = np.asarray(image, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).permute(2, 0, 1)
    except Exception as error:
        print(f"[v15b][warn] crop load failed {path}: {error}", flush=True)
        return torch.full((3, input_size, input_size), 0.5, dtype=torch.float32)


def normalize_tensor(tensor: torch.Tensor) -> torch.Tensor:
    mean = torch.as_tensor(IMAGENET_MEAN, dtype=torch.float32).view(3, 1, 1)
    std = torch.as_tensor(IMAGENET_STD, dtype=torch.float32).view(3, 1, 1)
    return (tensor - mean) / std


def region_to_pixels(region: list[float], width: int, height: int, context_pad: float) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = [float(value) for value in region]
    if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5:
        x1 *= width
        x2 *= width
        y1 *= height
        y2 *= height
    box_w = max(1.0, x2 - x1)
    box_h = max(1.0, y2 - y1)
    pad = max(box_w, box_h) * context_pad
    return (
        max(0, int(math.floor(x1 - pad))),
        max(0, int(math.floor(y1 - pad))),
        min(width, int(math.ceil(x2 + pad))),
        min(height, int(math.ceil(y2 + pad))),
    )


def box_to_region(box: dict[str, Any]) -> list[float]:
    x = float(box.get("x") or 0.0)
    y = float(box.get("y") or 0.0)
    w = float(box.get("width") or 0.0)
    h = float(box.get("height") or 0.0)
    return [x, y, x + w, y + h]


def read_holdout(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            if "photoId" not in row:
                for key in list(row.keys()):
                    if key.replace("\ufeff", "") == "photoId":
                        row["photoId"] = row[key]
            rows.append(row)
    return rows


def valid_region(region: Any) -> bool:
    if not isinstance(region, list) or len(region) != 4:
        return False
    try:
        x1, y1, x2, y2 = [float(value) for value in region]
        return x2 > x1 and y2 > y1
    except Exception:
        return False


def summarize_samples(samples: list[CropSample]) -> dict[str, Any]:
    return {
        "count": len(samples),
        "photoCount": len({norm_id(sample.photo_id) for sample in samples}),
        "labelCounts": dict(Counter("falseFace" if sample.label else "realFace" for sample in samples)),
        "datasetCounts": dict(Counter(sample.dataset for sample in samples)),
        "sceneCounts": dict(Counter(sample.scene_type for sample in samples)),
    }


def evaluate_scores(rows: list[dict[str, Any]], label_key: str, score_key: str, threshold: float) -> dict[str, Any]:
    labels = [int(row[label_key]) for row in rows]
    scores = [float(row[score_key]) for row in rows]
    return binary_metrics(labels, scores, threshold)


def binary_metrics(labels: list[int], scores: list[float], threshold: float) -> dict[str, Any]:
    positives = [(label, score) for label, score in zip(labels, scores) if label == 1]
    controls = [(label, score) for label, score in zip(labels, scores) if label == 0]
    tp = sum(1 for label, score in zip(labels, scores) if label == 1 and score >= threshold)
    fp = sum(1 for label, score in zip(labels, scores) if label == 0 and score >= threshold)
    return {
        "count": len(labels),
        "positiveCount": len(positives),
        "controlCount": len(controls),
        "auc": auc(labels, scores),
        "threshold": threshold,
        "tprAtThreshold": safe_div(tp, len(positives)),
        "fprAtThreshold": safe_div(fp, len(controls)),
        "positiveMean": safe_div(sum(score for _, score in positives), len(positives)),
        "controlMean": safe_div(sum(score for _, score in controls), len(controls)),
        "positiveMedian": median([score for _, score in positives]),
        "controlMedian": median([score for _, score in controls]),
    }


def auc(labels: list[int], scores: list[float]) -> float:
    pairs = sorted(zip(scores, labels), key=lambda item: item[0])
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return 0.0
    rank_sum = 0.0
    index = 0
    while index < len(pairs):
        end = index + 1
        while end < len(pairs) and pairs[end][0] == pairs[index][0]:
            end += 1
        avg_rank = (index + 1 + end) / 2.0
        rank_sum += avg_rank * sum(label for _, label in pairs[index:end])
        index = end
    return (rank_sum - pos * (pos + 1) / 2.0) / (pos * neg)


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    return (values[mid - 1] + values[mid]) / 2.0


def write_report_markdown(
    out_dir: Path,
    dataset_manifest: dict[str, Any],
    training_report: dict[str, Any],
    holdout_summary: dict[str, Any],
    full_coverage: dict[str, Any],
) -> str:
    hm = holdout_summary["metrics"]
    v15b = full_coverage["v15b"]
    v15 = full_coverage["v15Reference"]
    lines = [
        "# FrameCull False Face v15B Crop Classifier Report",
        "",
        "## Verdict Pending Replay",
        "",
        "This report is written immediately after crop classifier scoring. The recall replay step must still be run with `tools/ai-lab/replay-v15-false-face-guard.mjs` against this directory before any automatic interception decision.",
        "",
        "## Dataset",
        "",
        f"- Teacher records read: `{dataset_manifest['totalTeacherRecordsRead']}`",
        f"- Usable crop samples: `{dataset_manifest['totalUsableCropSamples']}`",
        f"- Label counts: `{dataset_manifest['labelCounts']}`",
        f"- Holdout intersection count: `{dataset_manifest['holdoutIntersectionCount']}`",
        "",
        "## Training",
        "",
        f"- Model: `{training_report['model']['modelName']}`",
        f"- Device: `{training_report['model']['device']}`",
        f"- Best val AUC: `{training_report['training']['bestValAuc']:.4f}` at epoch `{training_report['training']['bestEpoch']}`",
        "",
        "## 84 Holdout",
        "",
        f"- AUC: `{hm['auc']:.4f}`",
        f"- TPR@0.5: `{hm['tprAtThreshold']:.4f}`",
        f"- FPR@0.5: `{hm['fprAtThreshold']:.4f}`",
        "- Holdout was not used for training, tuning, or threshold fitting.",
        "",
        "## Full Gate Coverage",
        "",
        f"- v15 upstream gate rate: `{float_or(v15.get('upstreamGateTriggerRate'), 0.0):.4f}`",
        f"- v15B upstream gate rate: `{v15b['upstreamGateTriggerRate']:.4f}`",
        f"- v15 guard trigger rate: `{float_or(v15.get('guardTriggerRate'), 0.0):.4f}`",
        f"- v15B guard trigger rate: `{v15b['guardTriggerRate']:.4f}`",
        f"- v15B teacher-proxy guard real-face count: `{v15b['teacherProxyGuardRealFaceCount']}`",
        f"- v15B teacher-proxy high-risk false-face count: `{v15b['teacherProxyGuardFalseFaceHighRiskCount']}`",
        "",
        "## Files",
        "",
        f"- `{out_dir / 'crop-dataset-manifest.json'}`",
        f"- `{out_dir / 'training-report-v15b.json'}`",
        f"- `{out_dir / 'upstream-gate-v2-coverage.json'}`",
        f"- `{out_dir / 'v15b-holdout-scores.csv'}`",
        f"- `{out_dir / 'guard-full-scores.json'}`",
    ]
    return "\n".join(lines) + "\n"


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def norm_id(value: Any) -> str:
    return Path(str(value or "").strip()).stem.lower()


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def safe_div(num: float, den: float) -> float:
    return float(num) / float(den) if den else 0.0


def float_or(value: Any, fallback: float) -> float:
    try:
        if value is None or value == "":
            return fallback
        out = float(value)
        return out if math.isfinite(out) else fallback
    except Exception:
        return fallback


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


if __name__ == "__main__":
    main()
