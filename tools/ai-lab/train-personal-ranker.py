#!/usr/bin/env python3
r"""Train FrameCull personal aesthetic rankers from RAW+XMP audit data.

Heavy models and feature caches stay outside the app bundle under
D:\FrameCullModelLab by default. XMP ratings are evaluation labels only and
are never added to ranking features.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception as exc:  # pragma: no cover - script dependency gate
    raise SystemExit(f"PyTorch is required in the D-drive lab environment: {exc}") from exc

try:
    from PIL import Image
    from PIL import ImageFile
except Exception as exc:  # pragma: no cover - script dependency gate
    raise SystemExit(f"Pillow is required in the D-drive lab environment: {exc}") from exc

ImageFile.LOAD_TRUNCATED_IMAGES = True


DEFAULT_AUDIT = Path("output/ai-bench/ai-culling-bench-scene-aware-replay.json")
DEFAULT_CANDIDATES = Path("output/ai-bench/aesthetic-candidates/aesthetic-candidates-20260616-104143.csv")
DEFAULT_LABELS = Path(r"D:\FrameCullRawAudit\raw-audit-previews\labels.json")
DEFAULT_PREVIEWS = Path(r"D:\FrameCullRawAudit\raw-audit-previews")
DEFAULT_LAB = Path(r"D:\FrameCullModelLab")
DEFAULT_OUTPUT = Path("output/ai-bench/personal-ranker")
DEFAULT_RATIOS = (0.38, 0.45, 0.50, 0.60)

SCHEMA = "framecull-personal-aesthetic-ranker-v1"
CORE_FEATURES = [
    "overall",
    "technical",
    "aesthetic",
    "scene",
    "focusTexture",
    "focusPeakTexture",
    "focusReliability",
    "focusReliable",
    "nimaScore",
    "musiqScore",
    "clipIqaScore",
    "fusedBalancedScore",
    "fusedRecallScore",
    "hardIssueCount",
    "reviewHintCount",
    "gateReasonCount",
    "exclusionReasonCount",
    "inDuplicateGroup",
    "formalBest",
    "isGroupRepresentative",
    "duplicateGroupSize",
    "bestSimilarity",
    "avgPairSimilarity",
    "maxPairSimilarity",
]
FORBIDDEN_FEATURE_HINTS = ("rating", "folder", "filename", "file_name", "source")


@dataclass
class Record:
    id: str
    file_name: str
    preview_path: Path | None
    rating: int | None
    positive: bool | None
    negative: bool | None
    usable: bool
    issue_blocked: bool
    duplicate_group_key: str | None
    feature_map: dict[str, float]
    source_name: str


@dataclass
class PreparedDataset:
    records: list[Record]
    labeled_indices: np.ndarray
    y: np.ndarray
    feature_matrix: np.ndarray
    feature_names: list[str]
    feature_mean: np.ndarray
    feature_std: np.ndarray


class LinearRanker(nn.Module):
    def __init__(self, input_dim: int):
        super().__init__()
        self.linear = nn.Linear(input_dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.linear(x).squeeze(-1)


class MlpRanker(nn.Module):
    def __init__(self, input_dim: int, hidden: int = 64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden),
            nn.ReLU(),
            nn.Dropout(0.08),
            nn.Linear(hidden, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train FrameCull personal aesthetic ranker heads.")
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS)
    parser.add_argument("--previews", type=Path, default=DEFAULT_PREVIEWS)
    parser.add_argument("--candidates", type=Path, default=DEFAULT_CANDIDATES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--lab", type=Path, default=DEFAULT_LAB)
    parser.add_argument("--ratios", default=",".join(str(r) for r in DEFAULT_RATIOS))
    parser.add_argument(
        "--models",
        default="core-linear,core-mlp",
        help="Comma list: core-linear,core-mlp,dinov2-linear,clip-linear,fused-dinov2-linear,fused-clip-linear",
    )
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--embedding-batch", type=int, default=24)
    parser.add_argument("--max-edge", type=int, default=518)
    parser.add_argument("--epochs", type=int, default=420)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--limit", type=int, default=0, help="Debug limit over records; 0 means all.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ensure_external_lab_paths(args)
    set_cache_env(args.lab)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    args.output.mkdir(parents=True, exist_ok=True)
    feature_cache_dir = args.lab / "features" / "personal-ranker"
    feature_cache_dir.mkdir(parents=True, exist_ok=True)

    audit = read_json(args.audit)
    labels_manifest = read_json(args.labels)
    candidates = read_candidate_csv(args.candidates)
    ratios = [float(value) for value in args.ratios.split(",") if value.strip()]
    requested_models = [part.strip() for part in args.models.split(",") if part.strip()]
    pair_context = build_pair_context(audit)
    group_context = build_duplicate_group_context(audit)
    records = build_records(
        audit.get("photoSummaries", []),
        labels_manifest,
        candidates,
        args.previews,
        pair_context,
        group_context,
    )
    if args.limit > 0:
        records = records[: args.limit]

    dataset = prepare_core_dataset(records)
    device = choose_device(args.device)
    gpu = probe_gpu(device)
    model_results: list[dict[str, Any]] = []
    prediction_by_model: dict[str, np.ndarray] = {}

    baseline_scores = np.array([record.feature_map.get("overall", 0.0) for record in records], dtype=np.float32)
    model_results.append(evaluate_model("current-production-score", "baseline", records, baseline_scores, ratios, None))
    prediction_by_model["current-production-score"] = baseline_scores

    if "core-linear" in requested_models:
        result, predictions, importances = train_torch_ranker(
            "core-linear",
            "existing-framecull-linear-head",
            dataset,
            ratios,
            LinearRanker,
            args.epochs,
            args.seed,
            args.folds,
            device,
            records,
        )
        result["featureImportance"] = importances[:30]
        model_results.append(result)
        prediction_by_model["core-linear"] = predictions

    if "core-mlp" in requested_models:
        result, predictions, importances = train_torch_ranker(
            "core-mlp",
            "existing-framecull-mlp-head",
            dataset,
            ratios,
            MlpRanker,
            args.epochs,
            args.seed + 11,
            args.folds,
            device,
            records,
        )
        result["featureImportance"] = importances[:30]
        model_results.append(result)
        prediction_by_model["core-mlp"] = predictions

    embedding_statuses: dict[str, dict[str, Any]] = {}
    embedding_specs = {
        "dinov2": {
            "trigger_models": {"dinov2-linear", "fused-dinov2-linear"},
            "extractor": extract_dinov2_embeddings,
        },
        "clip": {
            "trigger_models": {"clip-linear", "fused-clip-linear"},
            "extractor": extract_clip_embeddings,
        },
    }

    for embedding_name, spec in embedding_specs.items():
        if not (set(requested_models) & spec["trigger_models"]):
            continue
        try:
            embeddings, status = spec["extractor"](records, args, feature_cache_dir, device)
            embedding_statuses[embedding_name] = status
        except Exception as exc:
            embedding_statuses[embedding_name] = {
                "status": "ERROR",
                "error": repr(exc),
                "recommendation": "Keep this embedding family lab-only until extraction succeeds.",
            }
            continue

        embedding_dataset = prepare_embedding_dataset(records, embeddings, f"{embedding_name}-embedding")
        if f"{embedding_name}-linear" in requested_models:
            result, predictions, importances = train_torch_ranker(
                f"{embedding_name}-linear",
                f"{embedding_name}-frozen-embedding-linear-head",
                embedding_dataset,
                ratios,
                LinearRanker,
                args.epochs,
                args.seed + 23,
                args.folds,
                device,
                records,
            )
            result["featureImportance"] = importances[:30]
            model_results.append(result)
            prediction_by_model[f"{embedding_name}-linear"] = predictions

        fused_dataset = prepare_fused_dataset(dataset, embeddings, f"fused-{embedding_name}")
        if f"fused-{embedding_name}-linear" in requested_models:
            result, predictions, importances = train_torch_ranker(
                f"fused-{embedding_name}-linear",
                f"existing-features-plus-{embedding_name}-linear-head",
                fused_dataset,
                ratios,
                LinearRanker,
                args.epochs,
                args.seed + 37,
                args.folds,
                device,
                records,
            )
            result["featureImportance"] = importances[:30]
            model_results.append(result)
            prediction_by_model[f"fused-{embedding_name}-linear"] = predictions

    selected = select_model(model_results)
    selected_predictions = prediction_by_model.get(selected["name"], baseline_scores)
    selected_ratio = select_primary_ratio(selected)
    selected_pick_ids = set(pick_photo_ids(records, selected_predictions, selected_ratio))
    false_negatives = false_negative_rows(records, selected_pick_ids, selected_predictions)
    duplicate_pollution = duplicate_pollution_rows(records, selected_pick_ids, selected_predictions)
    feature_importance = selected.get("featureImportance") or []
    production = production_recommendation(selected, model_results, embedding_statuses)

    write_outputs(
        args=args,
        ratios=ratios,
        records=records,
        dataset=dataset,
        gpu=gpu,
        embedding_statuses=embedding_statuses,
        model_results=model_results,
        selected=selected,
        selected_ratio=selected_ratio,
        production=production,
        false_negatives=false_negatives,
        duplicate_pollution=duplicate_pollution,
        feature_importance=feature_importance,
    )

    print("FrameCull personal ranker lab complete.")
    print(f"Summary: {args.output / 'summary.md'}")
    print(f"Selected ranker: {selected['name']}")
    print(f"Production recommendation: {production['decision']}")
    return 0


def ensure_external_lab_paths(args: argparse.Namespace) -> None:
    for label, path_value in {
        "lab": args.lab,
        "previews": args.previews,
        "labels": args.labels,
    }.items():
        resolved = Path(path_value).resolve()
        resolved_text = str(resolved).replace("\\", "/").lower()
        if os.name == "nt":
            allowed = str(resolved).lower().startswith("d:\\")
            allowed_root = "D: drive"
        else:
            allowed = resolved_text == "/data/framecullmodellab" or resolved_text.startswith("/data/framecullmodellab/")
            allowed_root = "/data/FrameCullModelLab"
        if not allowed:
            raise SystemExit(f"{label} must stay under {allowed_root} for this lab: {path_value}")


def set_cache_env(lab: Path) -> None:
    cache = lab / "cache"
    env_paths = {
        "FRAMECULL_MODEL_LAB_DIR": lab,
        "HF_HOME": cache / "huggingface",
        "HUGGINGFACE_HUB_CACHE": cache / "huggingface" / "hub",
        "TRANSFORMERS_CACHE": cache / "huggingface" / "transformers",
        "TORCH_HOME": cache / "torch",
        "XDG_CACHE_HOME": cache / "xdg",
        "PIP_CACHE_DIR": cache / "pip",
        "TMP": cache / "tmp",
        "TEMP": cache / "tmp",
    }
    for key, value in env_paths.items():
        os.environ[str(key)] = str(value)
        Path(value).mkdir(parents=True, exist_ok=True)


def read_json(path_value: Path) -> dict[str, Any]:
    with Path(path_value).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_candidate_csv(path_value: Path) -> dict[str, dict[str, str]]:
    if not Path(path_value).exists():
        return {}
    with Path(path_value).open("r", encoding="utf-8", newline="") as handle:
        return {row["photo_id"]: row for row in csv.DictReader(handle)}


def build_pair_context(audit: dict[str, Any]) -> dict[str, dict[str, float]]:
    context: dict[str, dict[str, float]] = {}
    for pair in audit.get("pairSimilarities", []):
        left = str(pair.get("leftId", ""))
        right = str(pair.get("rightId", ""))
        similarity = finite_float(pair.get("similarity"), 0.0)
        if not left or not right:
            continue
        for a, b in ((left, right), (right, left)):
            stats = context.setdefault(a, {"bestSimilarity": 0.0, "sumSimilarity": 0.0, "count": 0.0})
            stats["bestSimilarity"] = max(stats["bestSimilarity"], similarity)
            stats["sumSimilarity"] += similarity
            stats["count"] += 1.0
    return context


def build_duplicate_group_context(audit: dict[str, Any]) -> dict[str, dict[str, Any]]:
    context: dict[str, dict[str, Any]] = {}
    groups = audit.get("compactDuplicateGroups", []) or []
    for index, group in enumerate(groups):
        photo_ids = [str(value) for value in group.get("photoIds", []) if value]
        key = str(group.get("id") or f"compact-{index}")
        for photo_id in photo_ids:
            context[photo_id] = {
                "groupKey": key,
                "size": len(photo_ids),
                "bestPhotoId": group.get("bestPhotoId"),
                "similarity": finite_float(group.get("similarity"), 0.0),
            }
    return context


def build_records(
    summaries: list[dict[str, Any]],
    labels_manifest: dict[str, Any],
    candidates: dict[str, dict[str, str]],
    previews_dir: Path,
    pair_context: dict[str, dict[str, float]],
    group_context: dict[str, dict[str, Any]],
) -> list[Record]:
    labels = labels_manifest.get("labels", {})
    source_names = labels_manifest.get("sourceNames", {})
    records: list[Record] = []
    for summary in summaries:
        photo_id = str(summary.get("id", ""))
        if not photo_id:
            continue
        rating_value = labels.get(photo_id, summary.get("groundTruthRating"))
        rating = int(rating_value) if rating_value is not None and str(rating_value).strip() != "" else None
        candidate = candidates.get(photo_id, {})
        group_info = group_context.get(photo_id, {})
        pair_stats = pair_context.get(photo_id, {})
        avg_pair = pair_stats["sumSimilarity"] / pair_stats["count"] if pair_stats.get("count") else 0.0
        issue_codes = list(summary.get("issueCodes", []) or [])
        hard_issue_codes = list(summary.get("hardIssueCodes", []) or [])
        review_hint_codes = list(summary.get("reviewHintCodes", []) or [])
        exclusion_reasons = list(summary.get("exclusionReasons", []) or [])
        gate_reasons = list(summary.get("gateReasons", []) or [])
        issue_blocked = bool(hard_issue_codes or issue_codes or obvious_blur(summary) or "REJECTED" in exclusion_reasons)
        usable = not issue_blocked and finite_float(summary.get("overall"), 0.0) >= 38 and finite_float(summary.get("technical"), 0.0) >= 20
        feature_map = {
            "overall": finite_float(summary.get("overall"), 0.0),
            "technical": finite_float(summary.get("technical"), 0.0),
            "aesthetic": finite_float(summary.get("aesthetic"), 0.0),
            "scene": finite_float(summary.get("scene"), 0.0),
            "focusTexture": finite_float(summary.get("focusTexture"), 0.0),
            "focusPeakTexture": finite_float(summary.get("focusPeakTexture"), 0.0),
            "focusReliability": finite_float(summary.get("focusReliability"), 0.0),
            "focusReliable": 1.0 if summary.get("focusReliable") else 0.0,
            "nimaScore": finite_float(candidate.get("nima-baseline_score"), finite_float(summary.get("aesthetic"), 0.0)),
            "musiqScore": finite_float(candidate.get("musiq-ava-pyiqa_score"), 0.0),
            "clipIqaScore": finite_float(candidate.get("clipiqa-pyiqa_score"), 0.0),
            "fusedBalancedScore": finite_float(candidate.get("fused-balanced_score"), 0.0),
            "fusedRecallScore": finite_float(candidate.get("fused-recall_score"), 0.0),
            "hardIssueCount": float(len(hard_issue_codes or issue_codes)),
            "reviewHintCount": float(len(review_hint_codes)),
            "gateReasonCount": float(len(gate_reasons)),
            "exclusionReasonCount": float(len(exclusion_reasons)),
            "inDuplicateGroup": 1.0 if summary.get("inDuplicateGroup") or group_info else 0.0,
            "formalBest": 1.0 if summary.get("formalBest") else 0.0,
            "isGroupRepresentative": 1.0 if group_info.get("bestPhotoId") == photo_id else 0.0,
            "duplicateGroupSize": float(group_info.get("size") or 1),
            "bestSimilarity": finite_float(pair_stats.get("bestSimilarity"), finite_float(group_info.get("similarity"), 0.0)),
            "avgPairSimilarity": finite_float(avg_pair, 0.0),
            "maxPairSimilarity": finite_float(pair_stats.get("bestSimilarity"), 0.0),
        }
        file_name = str(summary.get("fileName") or f"{photo_id}.jpg")
        preview_path = find_preview(previews_dir, photo_id, file_name)
        records.append(
            Record(
                id=photo_id,
                file_name=file_name,
                preview_path=preview_path,
                rating=rating,
                positive=None if rating is None else rating >= 3,
                negative=None if rating is None else rating <= 1,
                usable=usable,
                issue_blocked=issue_blocked,
                duplicate_group_key=group_info.get("groupKey"),
                feature_map=feature_map,
                source_name=str(summary.get("sourceName") or source_names.get(photo_id, "")),
            )
        )
    return sorted(records, key=photo_sort_key)


def photo_sort_key(record: Record) -> tuple[int, str]:
    digits = "".join(ch for ch in record.id if ch.isdigit())
    return (int(digits) if digits else 0, record.id)


def obvious_blur(summary: dict[str, Any]) -> bool:
    focus_texture = finite_float(summary.get("focusTexture"), 100.0)
    focus_peak = finite_float(summary.get("focusPeakTexture"), 100.0)
    reliability = finite_float(summary.get("focusReliability"), 1.0)
    hard_codes = set(summary.get("hardIssueCodes", []) or [])
    issue_codes = set(summary.get("issueCodes", []) or [])
    if "OUT_OF_FOCUS" in hard_codes or "OUT_OF_FOCUS" in issue_codes:
        return True
    return focus_texture < 30 and focus_peak < 38 and reliability < 0.42


def find_preview(previews_dir: Path, photo_id: str, file_name: str) -> Path | None:
    candidates = [
        previews_dir / f"{photo_id}.jpg",
        previews_dir / f"{photo_id}.jpeg",
        previews_dir / file_name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def finite_float(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def prepare_core_dataset(records: list[Record]) -> PreparedDataset:
    validate_feature_names(CORE_FEATURES)
    matrix = np.array([[record.feature_map.get(name, 0.0) for name in CORE_FEATURES] for record in records], dtype=np.float32)
    return standardize_dataset(records, matrix, CORE_FEATURES)


def prepare_embedding_dataset(records: list[Record], embeddings: np.ndarray, prefix: str) -> PreparedDataset:
    names = [f"{prefix}-{index:04d}" for index in range(embeddings.shape[1])]
    return standardize_dataset(records, embeddings.astype(np.float32), names)


def prepare_fused_dataset(core: PreparedDataset, embeddings: np.ndarray, prefix: str) -> PreparedDataset:
    names = core.feature_names + [f"{prefix}-embedding-{index:04d}" for index in range(embeddings.shape[1])]
    matrix = np.concatenate([core.feature_matrix, standardize_raw(embeddings.astype(np.float32))[0]], axis=1)
    return PreparedDataset(core.records, core.labeled_indices, core.y, matrix, names, np.zeros(len(names)), np.ones(len(names)))


def standardize_dataset(records: list[Record], raw_matrix: np.ndarray, names: list[str]) -> PreparedDataset:
    labeled_indices = np.array([index for index, record in enumerate(records) if record.positive is not None], dtype=np.int64)
    y = np.array([1.0 if records[index].positive else 0.0 for index in labeled_indices], dtype=np.float32)
    normalized, mean, std = standardize_raw(raw_matrix)
    return PreparedDataset(records, labeled_indices, y, normalized, names, mean, std)


def standardize_raw(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = np.nanmean(matrix, axis=0)
    std = np.nanstd(matrix, axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    normalized = (np.nan_to_num(matrix, nan=0.0, posinf=0.0, neginf=0.0) - mean) / std
    return normalized.astype(np.float32), mean.astype(np.float32), std.astype(np.float32)


def validate_feature_names(names: Iterable[str]) -> None:
    lowered = [name.lower() for name in names]
    leaks = [name for name in lowered if any(hint in name for hint in FORBIDDEN_FEATURE_HINTS)]
    if leaks:
        raise SystemExit(f"Potential label leakage feature names are forbidden: {leaks}")


def choose_device(requested: str) -> torch.device:
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def probe_gpu(device: torch.device) -> dict[str, Any]:
    cuda_available = torch.cuda.is_available()
    return {
        "python": sys.executable,
        "torch": getattr(torch, "__version__", "unknown"),
        "device": str(device),
        "cudaAvailable": cuda_available,
        "gpu": torch.cuda.get_device_name(0) if cuda_available else None,
    }


def stratified_folds(y: np.ndarray, folds: int, seed: int) -> list[tuple[np.ndarray, np.ndarray]]:
    rng = np.random.default_rng(seed)
    pos = np.where(y >= 0.5)[0]
    neg = np.where(y < 0.5)[0]
    rng.shuffle(pos)
    rng.shuffle(neg)
    buckets = [[] for _ in range(max(2, folds))]
    for index, value in enumerate(pos):
        buckets[index % len(buckets)].append(int(value))
    for index, value in enumerate(neg):
        buckets[index % len(buckets)].append(int(value))
    splits = []
    all_indices = np.arange(len(y), dtype=np.int64)
    for bucket in buckets:
        val = np.array(sorted(bucket), dtype=np.int64)
        if len(val) == 0:
            continue
        train = np.setdiff1d(all_indices, val)
        splits.append((train, val))
    return splits


def train_torch_ranker(
    name: str,
    family: str,
    dataset: PreparedDataset,
    ratios: list[float],
    model_factory: type[nn.Module],
    epochs: int,
    seed: int,
    folds: int,
    device: torch.device,
    records: list[Record],
) -> tuple[dict[str, Any], np.ndarray, list[dict[str, Any]]]:
    x_labeled = dataset.feature_matrix[dataset.labeled_indices]
    y = dataset.y
    oof = np.zeros(len(y), dtype=np.float32)
    fold_metrics = []
    for fold_index, (train_idx, val_idx) in enumerate(stratified_folds(y, folds, seed)):
        torch.manual_seed(seed + fold_index)
        model = model_factory(dataset.feature_matrix.shape[1]).to(device)
        train_model(model, x_labeled[train_idx], y[train_idx], epochs, device, seed + fold_index)
        with torch.no_grad():
            logits = model(torch.tensor(x_labeled[val_idx], dtype=torch.float32, device=device)).detach().cpu().numpy()
        oof[val_idx] = logits
        fold_metrics.append({"fold": fold_index, "auc": auc_score(y[val_idx], logits)})

    torch.manual_seed(seed + 999)
    final_model = model_factory(dataset.feature_matrix.shape[1]).to(device)
    train_model(final_model, x_labeled, y, epochs, device, seed + 999)
    with torch.no_grad():
        all_scores = final_model(torch.tensor(dataset.feature_matrix, dtype=torch.float32, device=device)).detach().cpu().numpy()

    eval_scores = all_scores.astype(np.float32).copy()
    eval_scores[dataset.labeled_indices] = oof
    result = evaluate_model(name, family, records, eval_scores, ratios, oof)
    result["foldMetrics"] = fold_metrics
    result["oofAuc"] = auc_score(y, oof)
    result["trainAuc"] = auc_score(
        y,
        np.array([all_scores[index] for index in dataset.labeled_indices], dtype=np.float32),
    )
    result["labeledCount"] = int(len(y))
    return result, eval_scores.astype(np.float32), linear_feature_importance(final_model, dataset.feature_names)


def train_model(model: nn.Module, x_train: np.ndarray, y_train: np.ndarray, epochs: int, device: torch.device, seed: int) -> None:
    rng = np.random.default_rng(seed)
    x = torch.tensor(x_train, dtype=torch.float32, device=device)
    y = torch.tensor(y_train, dtype=torch.float32, device=device)
    pos_count = max(1.0, float((y_train >= 0.5).sum()))
    neg_count = max(1.0, float((y_train < 0.5).sum()))
    pos_weight = torch.tensor([min(12.0, neg_count / pos_count)], dtype=torch.float32, device=device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.012, weight_decay=0.05)
    best_loss = float("inf")
    stale = 0
    for epoch in range(max(80, epochs)):
        order = torch.tensor(rng.permutation(len(y_train)), dtype=torch.long, device=device)
        logits = model(x[order])
        loss = F.binary_cross_entropy_with_logits(logits, y[order], pos_weight=pos_weight)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        value = float(loss.detach().cpu())
        if value + 1e-5 < best_loss:
            best_loss = value
            stale = 0
        else:
            stale += 1
        if epoch > 120 and stale > 80:
            break


def linear_feature_importance(model: nn.Module, names: list[str]) -> list[dict[str, Any]]:
    weights = None
    if isinstance(model, LinearRanker):
        weights = model.linear.weight.detach().cpu().numpy().reshape(-1)
    elif isinstance(model, MlpRanker):
        first = model.net[0].weight.detach().cpu().numpy()
        last = model.net[-1].weight.detach().cpu().numpy().reshape(-1)
        weights = np.matmul(last, first)
    if weights is None:
        return []
    rows = [
        {"feature": name, "weight": float(weight), "absWeight": float(abs(weight))}
        for name, weight in zip(names, weights)
    ]
    return sorted(rows, key=lambda row: row["absWeight"], reverse=True)


def evaluate_model(
    name: str,
    family: str,
    records: list[Record],
    scores: np.ndarray,
    ratios: list[float],
    oof_labeled_scores: np.ndarray | None,
) -> dict[str, Any]:
    by_ratio = []
    for ratio in ratios:
        picked = set(pick_photo_ids(records, scores, ratio))
        by_ratio.append(metrics_for_picks(records, scores, picked, ratio))
    labeled_indices = [index for index, record in enumerate(records) if record.positive is not None]
    y = np.array([1.0 if records[index].positive else 0.0 for index in labeled_indices], dtype=np.float32)
    labeled_scores = np.array([scores[index] for index in labeled_indices], dtype=np.float32)
    return {
        "name": name,
        "family": family,
        "auc": auc_score(y, labeled_scores),
        "oofAuc": auc_score(y, oof_labeled_scores) if oof_labeled_scores is not None else None,
        "ratios": by_ratio,
    }


def pick_photo_ids(records: list[Record], scores: np.ndarray, ratio: float) -> list[str]:
    usable_indices = [index for index, record in enumerate(records) if record.usable]
    target = max(1, int(round(len(usable_indices) * ratio))) if usable_indices else 0
    selected: list[int] = []
    selected_set: set[int] = set()
    grouped: dict[str, list[int]] = {}
    for index in usable_indices:
        key = records[index].duplicate_group_key
        if key:
            grouped.setdefault(key, []).append(index)
    grouped_members = {index for members in grouped.values() for index in members}
    for members in grouped.values():
        best = max(members, key=lambda idx: (scores[idx], records[idx].feature_map.get("technical", 0.0), records[idx].feature_map.get("overall", 0.0)))
        selected.append(best)
        selected_set.add(best)
    solo = [index for index in usable_indices if index not in grouped_members]
    solo.sort(key=lambda idx: scores[idx], reverse=True)
    for index in solo:
        if len(selected) >= target:
            break
        selected.append(index)
        selected_set.add(index)
    if len(selected) < target:
        remaining_group_members = [index for index in grouped_members if index not in selected_set]
        remaining_group_members.sort(key=lambda idx: scores[idx], reverse=True)
        for index in remaining_group_members:
            if len(selected) >= target:
                break
            selected.append(index)
            selected_set.add(index)
    return [records[index].id for index in selected]


def metrics_for_picks(records: list[Record], scores: np.ndarray, picked: set[str], ratio: float) -> dict[str, Any]:
    labeled = [record for record in records if record.positive is not None]
    positives = [record for record in labeled if record.positive]
    negatives = [record for record in labeled if record.negative]
    true_positive = sum(1 for record in positives if record.id in picked)
    false_positive = sum(1 for record in negatives if record.id in picked)
    duplicate_multi = duplicate_multi_pick_count(records, picked)
    return {
        "ratio": ratio,
        "target": int(round(sum(1 for record in records if record.usable) * ratio)),
        "picked": len(picked),
        "labeledPicked": sum(1 for record in labeled if record.id in picked),
        "truePositive": true_positive,
        "falseNegative": max(0, len(positives) - true_positive),
        "falsePositive": false_positive,
        "recall": true_positive / len(positives) if positives else 0.0,
        "precisionOnLabeled": true_positive / max(1, true_positive + false_positive),
        "negativePickRate": false_positive / len(negatives) if negatives else 0.0,
        "duplicateGroupsWithMultiplePicks": duplicate_multi,
        "blockedPicked": sum(1 for record in records if record.issue_blocked and record.id in picked),
        "unusablePicked": sum(1 for record in records if not record.usable and record.id in picked),
        "scoreMeanPicked": float(np.mean([scores[index] for index, record in enumerate(records) if record.id in picked])) if picked else 0.0,
    }


def duplicate_multi_pick_count(records: list[Record], picked: set[str]) -> int:
    groups: dict[str, int] = {}
    for record in records:
        if not record.duplicate_group_key or record.id not in picked:
            continue
        groups[record.duplicate_group_key] = groups.get(record.duplicate_group_key, 0) + 1
    return sum(1 for count in groups.values() if count > 1)


def auc_score(y: np.ndarray, scores: np.ndarray | None) -> float | None:
    if scores is None or len(scores) == 0:
        return None
    pos = scores[y >= 0.5]
    neg = scores[y < 0.5]
    if len(pos) == 0 or len(neg) == 0:
        return None
    combined = np.concatenate([pos, neg])
    order = np.argsort(combined)
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, len(combined) + 1)
    rank_sum_pos = ranks[: len(pos)].sum()
    return float((rank_sum_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def select_model(results: list[dict[str, Any]]) -> dict[str, Any]:
    def score(result: dict[str, Any]) -> tuple[float, float, float, float]:
        ratio_map = {round(row["ratio"], 2): row for row in result["ratios"]}
        low = ratio_map.get(0.38, result["ratios"][0])
        mid = ratio_map.get(0.50, result["ratios"][min(2, len(result["ratios"]) - 1)])
        high = ratio_map.get(0.60, result["ratios"][-1])
        dup_penalty = sum(row["duplicateGroupsWithMultiplePicks"] for row in result["ratios"]) * 0.02
        neg_penalty = sum(row["negativePickRate"] for row in result["ratios"]) * 0.08
        blocked_penalty = sum(row["blockedPicked"] + row["unusablePicked"] for row in result["ratios"])
        return (
            low["recall"] * 1.7 + mid["recall"] * 1.35 + high["recall"] - dup_penalty - neg_penalty - blocked_penalty,
            low["recall"],
            mid["recall"],
            high["recall"],
        )
    return max(results, key=score)


def select_primary_ratio(result: dict[str, Any]) -> float:
    return 0.5 if any(abs(row["ratio"] - 0.5) < 1e-6 for row in result["ratios"]) else result["ratios"][0]["ratio"]


def false_negative_rows(records: list[Record], picked: set[str], scores: np.ndarray) -> list[dict[str, Any]]:
    rows = []
    for index, record in enumerate(records):
        if not record.positive or record.id in picked:
            continue
        rows.append(record_row(record, scores[index], "false-negative"))
    rows.sort(key=lambda row: row["score"], reverse=True)
    return rows[:160]


def duplicate_pollution_rows(records: list[Record], picked: set[str], scores: np.ndarray) -> list[dict[str, Any]]:
    by_group: dict[str, list[tuple[int, Record]]] = {}
    for index, record in enumerate(records):
        if record.duplicate_group_key and record.id in picked:
            by_group.setdefault(record.duplicate_group_key, []).append((index, record))
    rows = []
    for key, members in by_group.items():
        if len(members) <= 1:
            continue
        for index, record in members:
            row = record_row(record, scores[index], "duplicate-pollution")
            row["duplicateGroupKey"] = key
            row["selectedInGroup"] = len(members)
            rows.append(row)
    rows.sort(key=lambda row: (row["duplicateGroupKey"], -row["score"]))
    return rows[:200]


def record_row(record: Record, score: float, reason: str) -> dict[str, Any]:
    return {
        "id": record.id,
        "fileName": record.file_name,
        "rating": record.rating if record.rating is not None else "",
        "positive": record.positive,
        "negative": record.negative,
        "score": float(score),
        "usable": record.usable,
        "blocked": record.issue_blocked,
        "reason": reason,
        "overall": record.feature_map.get("overall", 0.0),
        "technical": record.feature_map.get("technical", 0.0),
        "aesthetic": record.feature_map.get("aesthetic", 0.0),
        "scene": record.feature_map.get("scene", 0.0),
        "duplicateGroupKey": record.duplicate_group_key or "",
        "previewPath": str(record.preview_path or ""),
    }


def production_recommendation(
    selected: dict[str, Any],
    results: list[dict[str, Any]],
    embedding_statuses: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    baseline = next((result for result in results if result["name"] == "current-production-score"), results[0])
    selected_by_ratio = {round(row["ratio"], 2): row for row in selected["ratios"]}
    baseline_by_ratio = {round(row["ratio"], 2): row for row in baseline["ratios"]}
    gains = {
        str(ratio): selected_by_ratio[ratio]["recall"] - baseline_by_ratio.get(ratio, {"recall": 0.0})["recall"]
        for ratio in selected_by_ratio.keys()
    }
    low_ratio_gain = max(gains.get("0.38", 0.0), gains.get("0.45", 0.0), gains.get("0.5", 0.0))
    uses_embedding = "dino" in selected["name"] or "clip" in selected["name"]
    if uses_embedding and low_ratio_gain >= 0.05:
        decision = "optional-high-accuracy-model-pack"
    elif not uses_embedding and low_ratio_gain >= 0.03:
        decision = "default-tiny-ranker"
    else:
        decision = "no-production-change-yet"
    return {
        "decision": decision,
        "selected": selected["name"],
        "lowRatioGain": low_ratio_gain,
        "recallGains": gains,
        "embeddingStatuses": embedding_statuses,
        "notes": [
            "Hard gates and duplicate representatives remain outside the learned model.",
            "Ratings were used only as supervision/evaluation labels, not ranking features.",
            "Embedding models should stay optional unless they clear a low-ratio recall gain threshold.",
        ],
    }


def extract_dinov2_embeddings(
    records: list[Record],
    args: argparse.Namespace,
    cache_dir: Path,
    device: torch.device,
) -> tuple[np.ndarray, dict[str, Any]]:
    import timm
    from torchvision import transforms

    cache_path = cache_dir / cache_file_name("dinov2-vit-small", records, args.max_edge)
    if cache_path.exists():
        payload = np.load(cache_path, allow_pickle=True)
        return payload["embeddings"], dict(payload["status"].item())

    started = time.perf_counter()
    model_name = "vit_small_patch14_dinov2.lvd142m"
    model = timm.create_model(model_name, pretrained=True, num_classes=0).to(device)
    model.eval()
    transform = transforms.Compose([
        transforms.Resize((args.max_edge, args.max_edge)),
        transforms.ToTensor(),
        transforms.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
    ])
    embeddings = run_embedding_model(records, model, transform, device, args.embedding_batch)
    status = {
        "status": "READY",
        "model": model_name,
        "seconds": time.perf_counter() - started,
        "dimension": int(embeddings.shape[1]),
    }
    np.savez_compressed(cache_path, embeddings=embeddings, status=np.array(status, dtype=object))
    return embeddings, status


def extract_clip_embeddings(
    records: list[Record],
    args: argparse.Namespace,
    cache_dir: Path,
    device: torch.device,
) -> tuple[np.ndarray, dict[str, Any]]:
    import clip

    cache_path = cache_dir / cache_file_name("clip-vit-b32", records, args.max_edge)
    if cache_path.exists():
        payload = np.load(cache_path, allow_pickle=True)
        return payload["embeddings"], dict(payload["status"].item())

    started = time.perf_counter()
    download_root = args.lab / "cache" / "clip"
    download_root.mkdir(parents=True, exist_ok=True)
    model, preprocess = clip.load("ViT-B/32", device=str(device), download_root=str(download_root))
    model.eval()
    tensors = []
    embeddings = []
    for record in records:
        tensors.append(load_preprocessed_image(record.preview_path, preprocess))
        if len(tensors) >= args.embedding_batch:
            embeddings.append(encode_clip_batch(model, tensors, device))
            tensors = []
    if tensors:
        embeddings.append(encode_clip_batch(model, tensors, device))
    matrix = np.concatenate(embeddings, axis=0).astype(np.float32)
    status = {
        "status": "READY",
        "model": "OpenAI CLIP ViT-B/32",
        "seconds": time.perf_counter() - started,
        "dimension": int(matrix.shape[1]),
    }
    np.savez_compressed(cache_path, embeddings=matrix, status=np.array(status, dtype=object))
    return matrix, status


def cache_file_name(model_name: str, records: list[Record], max_edge: int) -> str:
    digest = hashlib.sha256()
    digest.update(model_name.encode("utf-8"))
    digest.update(str(max_edge).encode("utf-8"))
    for record in records:
        digest.update(record.id.encode("utf-8"))
        if record.preview_path and record.preview_path.exists():
            stat = record.preview_path.stat()
            digest.update(str(stat.st_size).encode("utf-8"))
            digest.update(str(int(stat.st_mtime)).encode("utf-8"))
    return f"{model_name}-{digest.hexdigest()[:16]}.npz"


def run_embedding_model(records: list[Record], model: nn.Module, transform: Any, device: torch.device, batch_size: int) -> np.ndarray:
    batches = []
    current = []
    with torch.no_grad():
        for record in records:
            current.append(load_preprocessed_image(record.preview_path, transform))
            if len(current) >= batch_size:
                batches.append(encode_generic_batch(model, current, device))
                current = []
        if current:
            batches.append(encode_generic_batch(model, current, device))
    return np.concatenate(batches, axis=0).astype(np.float32)


def load_preprocessed_image(path_value: Path | None, transform: Any) -> torch.Tensor:
    if not path_value or not path_value.exists():
        image = Image.new("RGB", (224, 224), (0, 0, 0))
    else:
        try:
            image = Image.open(path_value).convert("RGB")
        except Exception:
            image = Image.new("RGB", (224, 224), (0, 0, 0))
    return transform(image)


def encode_generic_batch(model: nn.Module, tensors: list[torch.Tensor], device: torch.device) -> np.ndarray:
    batch = torch.stack(tensors).to(device)
    outputs = model(batch)
    outputs = F.normalize(outputs, dim=1)
    return outputs.detach().cpu().numpy()


def encode_clip_batch(model: Any, tensors: list[torch.Tensor], device: torch.device) -> np.ndarray:
    with torch.no_grad():
        batch = torch.stack(tensors).to(device)
        outputs = model.encode_image(batch)
        outputs = F.normalize(outputs, dim=1)
    return outputs.detach().cpu().numpy()


def write_outputs(
    args: argparse.Namespace,
    ratios: list[float],
    records: list[Record],
    dataset: PreparedDataset,
    gpu: dict[str, Any],
    embedding_statuses: dict[str, dict[str, Any]],
    model_results: list[dict[str, Any]],
    selected: dict[str, Any],
    selected_ratio: float,
    production: dict[str, Any],
    false_negatives: list[dict[str, Any]],
    duplicate_pollution: list[dict[str, Any]],
    feature_importance: list[dict[str, Any]],
) -> None:
    args.output.mkdir(parents=True, exist_ok=True)
    labels_manifest = read_json(args.labels)
    source_dirs = [str(value) for value in labels_manifest.get("sourceDirs", [])]
    write_csv(args.output / "metrics-by-ratio.csv", metrics_rows(model_results))
    write_json(args.output / "selected-ranker.json", {
        "schema": SCHEMA,
        "createdAt": iso_now(),
        "sourceDirs": source_dirs,
        "auditPath": str(args.audit),
        "labelsPath": str(args.labels),
        "previewsPath": str(args.previews),
        "modelLabPath": str(args.lab),
        "selected": selected,
        "selectedPrimaryRatio": selected_ratio,
        "productionRecommendation": production,
        "featureNames": dataset.feature_names,
        "featureMean": dataset.feature_mean.tolist(),
        "featureStd": dataset.feature_std.tolist(),
        "labelPolicy": {
            "positive": "XMP rating >= 3",
            "negative": "XMP rating 0/1",
            "unlabeled": "context only",
            "leakageGuards": [
                "rating excluded from rank features",
                "folder excluded from rank features",
                "source path excluded from rank features",
                "file name excluded from rank features",
                "XMP labels used only for evaluation and supervised loss",
            ],
        },
    })
    write_csv(args.output / "false-negatives.csv", false_negatives)
    write_csv(args.output / "duplicate-pollution.csv", duplicate_pollution)
    write_csv(args.output / "feature-importance.csv", feature_importance)
    summary = build_summary(
        args=args,
        ratios=ratios,
        records=records,
        gpu=gpu,
        embedding_statuses=embedding_statuses,
        model_results=model_results,
        selected=selected,
        production=production,
        source_dirs=source_dirs,
    )
    (args.output / "summary.md").write_text(summary, encoding="utf-8")


def metrics_rows(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for result in results:
        for ratio_row in result["ratios"]:
            rows.append({
                "model": result["name"],
                "family": result["family"],
                "auc": result.get("auc"),
                "oofAuc": result.get("oofAuc"),
                **ratio_row,
            })
    return rows


def write_csv(path_value: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path_value.write_text("", encoding="utf-8")
        return
    keys = list(rows[0].keys())
    with path_value.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_json(path_value: Path, payload: dict[str, Any]) -> None:
    path_value.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def build_summary(
    args: argparse.Namespace,
    ratios: list[float],
    records: list[Record],
    gpu: dict[str, Any],
    embedding_statuses: dict[str, dict[str, Any]],
    model_results: list[dict[str, Any]],
    selected: dict[str, Any],
    production: dict[str, Any],
    source_dirs: list[str],
) -> str:
    labeled = [record for record in records if record.positive is not None]
    positives = [record for record in labeled if record.positive]
    negatives = [record for record in labeled if record.negative]
    lines = [
        "# FrameCull Personal Aesthetic Ranker Lab",
        "",
        f"- Created: `{iso_now()}`",
        f"- Audit: `{args.audit}`",
        f"- Labels: `{args.labels}`",
        f"- Previews: `{args.previews}`",
        f"- Model lab: `{args.lab}`",
        f"- Source dirs: {', '.join(f'`{value}`' for value in source_dirs) if source_dirs else '`not recorded in labels manifest`'}",
        f"- Records: `{len(records)}` total, `{len(labeled)}` labeled, `{len(positives)}` positive, `{len(negatives)}` negative",
        f"- Selected ranker: `{selected['name']}`",
        f"- Production recommendation: **{production['decision']}**",
        "",
        "## GPU / Environment",
        "",
        f"- Python: `{gpu['python']}`",
        f"- Torch: `{gpu['torch']}`",
        f"- Device: `{gpu['device']}`",
        f"- CUDA available: `{gpu['cudaAvailable']}`",
        f"- GPU: `{gpu['gpu']}`",
        "",
        "## Model Metrics",
        "",
        "| Model | Family | Eval AUC | OOF AUC | Train AUC | Ratio | Picked | Recall | Precision labeled | Neg pick | Dup multi | Blocked |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for result in model_results:
        for row in result["ratios"]:
            lines.append(
                f"| `{result['name']}` | {result['family']} | {fmt(result.get('auc'))} | {fmt(result.get('oofAuc'))} | "
                f"{fmt(result.get('trainAuc'))} | {row['ratio']:.2f} | {row['picked']} | {pct(row['recall'])} | {pct(row['precisionOnLabeled'])} | "
                f"{pct(row['negativePickRate'])} | {row['duplicateGroupsWithMultiplePicks']} | {row['blockedPicked']} |"
            )
    lines.extend([
        "",
        "## Embedding Status",
        "",
    ])
    if embedding_statuses:
        for name, status in embedding_statuses.items():
            lines.append(f"- `{name}`: `{status.get('status')}` {status.get('model', '')} {status.get('error', '')}")
    else:
        lines.append("- No embedding models requested in this run.")
    lines.extend([
        "",
        "## Recommendation",
        "",
        f"- Decision: **{production['decision']}**",
        f"- Selected: `{production['selected']}`",
        f"- Low-ratio gain: `{production['lowRatioGain']:.4f}`",
        "- Keep hard issues, obvious blur, closed eyes, rejected photos, and duplicate non-representatives blocked outside the learned ranker.",
        "- XMP rating, folder/source path, and file name are never used as ranking features.",
        "- Do not ship DINOv2/CLIP by default unless an embedding model clears the low-ratio gain gate on more labeled shoots.",
        "",
        "## Output Files",
        "",
        "- `metrics-by-ratio.csv`",
        "- `selected-ranker.json`",
        "- `false-negatives.csv`",
        "- `duplicate-pollution.csv`",
        "- `feature-importance.csv`",
    ])
    return "\n".join(lines) + "\n"


def pct(value: float | None) -> str:
    if value is None:
        return "--"
    return f"{value * 100:.1f}%"


def fmt(value: float | None) -> str:
    if value is None:
        return "--"
    return f"{value:.4f}"


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


if __name__ == "__main__":
    raise SystemExit(main())
