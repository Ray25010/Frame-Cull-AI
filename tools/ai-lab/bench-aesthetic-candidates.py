#!/usr/bin/env python3
"""FrameCull AI aesthetic candidate model lab.

This script compares the current FrameCull/NIMA audit baseline with optional
MUSIQ and CLIP-IQA / CLIP-aesthetic candidates on the RAW+XMP audit set.

Candidate models are intentionally loaded from an external lab directory so
large or license-sensitive assets never enter the app bundle by accident.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import statistics
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageOps


DEFAULT_PREVIEW_DIR = Path(r"D:\FrameCullRawAudit\raw-audit-previews")
DEFAULT_LABELS_PATH = DEFAULT_PREVIEW_DIR / "labels.json"
DEFAULT_MODEL_LAB_DIR = Path(r"D:\FrameCullModelLab")
DEFAULT_OUTPUT_DIR = Path("output") / "ai-bench" / "aesthetic-candidates"
DEFAULT_RATIOS = (0.38, 0.50, 0.60)
DEFAULT_MODELS = ("nima-baseline", "musiq-ava-pyiqa", "clipiqa-pyiqa", "fused-balanced")
MODEL_LAB_SCHEMA_VERSION = "framecull-aesthetic-lab-v1"
SCORE_CACHE_VERSION = "score-cache-v2-musiq-ava-10x"


@dataclass
class PhotoRecord:
    photo_id: str
    file_name: str
    image_path: Path
    source_name: str | None
    rating: int | None
    positive: bool | None
    baseline: dict[str, Any]


@dataclass
class CandidateScore:
    model_id: str
    photo_id: str
    status: str
    score: float | None
    latency_ms: float | None
    error: str | None = None


class CandidateModel:
    model_id = "candidate"
    output_meaning = "unknown"
    license_risk = "unknown"

    def __init__(self, model_lab_dir: Path, device: str, candidate_max_edge: int = 1024) -> None:
        self.model_lab_dir = model_lab_dir
        self.device = device
        self.candidate_max_edge = candidate_max_edge
        self.package_size_bytes = 0
        self.load_error: str | None = None
        self.peak_process_rss_bytes: int | None = None
        self.peak_cuda_allocated_bytes: int | None = None

    def setup(self) -> None:
        return None

    def score(self, image_path: Path) -> float:
        raise NotImplementedError

    def manifest(self) -> dict[str, Any]:
        return {
            "modelId": self.model_id,
            "outputMeaning": self.output_meaning,
            "licenseRisk": self.license_risk,
            "device": self.device,
            "candidateMaxEdge": self.candidate_max_edge,
            "packageSizeBytes": self.package_size_bytes,
            "peakProcessRssBytes": self.peak_process_rss_bytes,
            "peakCudaAllocatedBytes": self.peak_cuda_allocated_bytes,
            "loadError": self.load_error,
        }


class NimaBaselineModel(CandidateModel):
    model_id = "nima-baseline"
    output_meaning = "Existing FrameCull AI photo summary aesthetic component."
    license_risk = "already-in-app-baseline"

    def __init__(self, model_lab_dir: Path, device: str, baseline_by_id: dict[str, dict[str, Any]], candidate_max_edge: int = 1024) -> None:
        super().__init__(model_lab_dir, device, candidate_max_edge)
        self.baseline_by_id = baseline_by_id

    def score(self, image_path: Path) -> float:
        photo_id = image_path.stem
        summary = self.baseline_by_id.get(photo_id) or {}
        value = summary.get("aesthetic")
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise RuntimeError("Missing baseline NIMA/aesthetic summary.")
        return float(value)


class PyiqaModel(CandidateModel):
    pyiqa_metric_name = ""
    output_meaning = "PyIQA score normalized to 0-100."
    license_risk = "external-lab-only"

    def setup(self) -> None:
        try:
            import pyiqa  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on optional dependency.
            self.load_error = (
                f"Missing optional dependency pyiqa/torch: {exc}. "
                "Install with: python -m pip install -r tools/ai-lab/requirements-aesthetic-candidates.txt"
            )
            raise

        try:
            self.metric = pyiqa.create_metric(self.pyiqa_metric_name, device=self.device)
        except Exception as exc:  # pragma: no cover - depends on model download/runtime.
            self.load_error = f"PyIQA could not create metric {self.pyiqa_metric_name}: {exc}"
            raise
        self.package_size_bytes = (
            directory_size(self.model_lab_dir / "models" / self.model_id) +
            directory_size(self.model_lab_dir / "cache" / "torch") +
            directory_size(self.model_lab_dir / "cache" / "huggingface")
        )

    def score(self, image_path: Path) -> float:
        candidate_path = prepare_candidate_image(image_path, self.model_lab_dir, self.candidate_max_edge)
        raw = self.metric(str(candidate_path))
        try:
            if hasattr(raw, "detach"):
                raw = raw.detach().cpu().numpy()
            value = float(np.asarray(raw).reshape(-1)[0])
        except Exception as exc:
            raise RuntimeError(f"Unable to read PyIQA output: {exc}") from exc
        return normalize_metric_score(self.model_id, value)


class MusiqPyiqaModel(PyiqaModel):
    model_id = "musiq-pyiqa"
    pyiqa_metric_name = "musiq"
    output_meaning = "MUSIQ multi-scale image quality/aesthetic score normalized to 0-100."
    license_risk = "lab-only-unverified-production-license"


class MusiqAvaPyiqaModel(PyiqaModel):
    model_id = "musiq-ava-pyiqa"
    pyiqa_metric_name = "musiq-ava"
    output_meaning = "MUSIQ AVA aesthetic score normalized to 0-100."
    license_risk = "lab-only-unverified-production-license"


class ClipIqaPyiqaModel(PyiqaModel):
    model_id = "clipiqa-pyiqa"
    pyiqa_metric_name = "clipiqa"
    output_meaning = "CLIP-IQA look-and-feel score normalized to 0-100."
    license_risk = "lab-only-unverified-production-license"


def main() -> int:
    args = parse_args()
    preview_dir = args.preview_dir.resolve()
    labels_path = args.labels.resolve()
    output_dir = args.output_dir.resolve()
    model_lab_dir = args.model_lab_dir.resolve()
    configure_external_caches(model_lab_dir)
    cache_path = args.cache.resolve() if args.cache else model_lab_dir / "cache" / "aesthetic-candidate-scores.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    ensure_model_lab_dirs(model_lab_dir)

    labels_manifest = read_json(labels_path)
    baseline = read_json(args.baseline.resolve()) if args.baseline else {}
    baseline_by_id = {item.get("id"): item for item in baseline.get("photoSummaries", []) if item.get("id")}
    records = build_records(preview_dir, labels_manifest, baseline_by_id, args.limit, args.stage)
    if not records:
        raise SystemExit(f"No audit preview JPGs found in {preview_dir}")

    cache = read_json(cache_path) if cache_path.exists() else {"schema": MODEL_LAB_SCHEMA_VERSION, "scores": {}}
    if cache.get("schema") != MODEL_LAB_SCHEMA_VERSION:
        cache = {"schema": MODEL_LAB_SCHEMA_VERSION, "scores": {}}

    selected_model_ids = [value.strip() for value in args.models.split(",") if value.strip()]
    models = build_models(selected_model_ids, model_lab_dir, args.device, args.candidate_max_edge, baseline_by_id)
    scores_by_model: dict[str, dict[str, CandidateScore]] = {}
    manifests: list[dict[str, Any]] = []

    started = time.perf_counter()
    for model in models:
        print(f"[FrameCull lab] scoring {model.model_id} on {len(records)} images...")
        model_scores = score_model(model, records, cache, cache_path, args.force, args.cache_save_every)
        scores_by_model[model.model_id] = model_scores
        manifests.append(model.manifest())
        save_json(cache_path, cache)

    elapsed_ms = (time.perf_counter() - started) * 1000
    fused_scores = build_fused_scores(records, scores_by_model)
    for model_id, model_scores in fused_scores.items():
        scores_by_model[model_id] = model_scores
        manifests.append({
            "modelId": model_id,
            "outputMeaning": "Offline fusion of FrameCull technical gates plus candidate aesthetic scores.",
            "licenseRisk": "derived-no-extra-model",
            "device": "offline",
            "packageSizeBytes": 0,
            "loadError": None,
        })

    ratio_values = parse_ratios(args.ratios)
    supervised_groups = baseline.get("duplicateStats", {}).get("supervisedGroups", [])
    metrics = {
        model_id: evaluate_model(records, model_id, model_scores, ratio_values, supervised_groups)
        for model_id, model_scores in scores_by_model.items()
    }
    recommendation = choose_recommendation(metrics, manifests, baseline_model_id="nima-baseline")
    result = {
        "schema": MODEL_LAB_SCHEMA_VERSION,
        "createdAt": iso_now(),
        "previewDir": str(preview_dir),
        "labelsPath": str(labels_path),
        "baselinePath": str(args.baseline.resolve()) if args.baseline else None,
        "modelLabDir": str(model_lab_dir),
        "stage": args.stage,
        "limit": args.limit,
        "device": args.device,
        "candidateMaxEdge": args.candidate_max_edge,
        "elapsedMs": round(elapsed_ms, 2),
        "records": {
            "total": len(records),
            "labeled": sum(1 for item in records if item.rating is not None),
            "positive": sum(1 for item in records if item.positive is True),
            "negative": sum(1 for item in records if item.positive is False),
        },
        "candidateManifests": manifests,
        "metrics": metrics,
        "recommendation": recommendation,
        "failureSamples": build_failure_samples(records, scores_by_model, metrics),
    }

    prefix = f"aesthetic-candidates-{timestamp_for_filename()}"
    json_path = output_dir / f"{prefix}.json"
    csv_path = output_dir / f"{prefix}.csv"
    summary_path = output_dir / f"{prefix}-summary.md"
    save_json(json_path, result)
    write_csv(csv_path, records, scores_by_model)
    write_summary(summary_path, result)

    print(json.dumps({
        "json": str(json_path),
        "csv": str(csv_path),
        "summary": str(summary_path),
        "recommendation": recommendation.get("decision"),
        "bestCandidate": recommendation.get("bestCandidate"),
        "records": result["records"],
    }, ensure_ascii=False, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate MUSIQ and CLIP-IQA candidates against FrameCull RAW+XMP labels.")
    parser.add_argument("--preview-dir", type=Path, default=DEFAULT_PREVIEW_DIR)
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS_PATH)
    parser.add_argument("--baseline", type=Path, default=find_latest_baseline())
    parser.add_argument("--model-lab-dir", type=Path, default=Path(os.environ.get("FRAMECULL_MODEL_LAB_DIR", DEFAULT_MODEL_LAB_DIR)))
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS[:-1]))
    parser.add_argument("--ratios", default=",".join(str(value) for value in DEFAULT_RATIOS))
    parser.add_argument("--stage", choices=("smoke-60", "balanced-labels", "labels-814", "radius-3-context", "all"), default="radius-3-context")
    parser.add_argument("--limit", type=int, default=0, help="Optional maximum image count after stage selection.")
    parser.add_argument("--device", default=os.environ.get("FRAMECULL_AESTHETIC_DEVICE", "cpu"))
    parser.add_argument("--candidate-max-edge", type=int, default=int(os.environ.get("FRAMECULL_AESTHETIC_MAX_EDGE", "1024")))
    parser.add_argument("--force", action="store_true", help="Ignore cached candidate scores.")
    parser.add_argument("--cache-save-every", type=int, default=10, help="Persist candidate score cache every N uncached images.")
    return parser.parse_args()


def find_latest_baseline() -> Path | None:
    bench_dir = Path("output") / "ai-bench"
    if not bench_dir.exists():
        return None
    candidates = sorted(bench_dir.glob("ai-culling-bench-*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        try:
            data = read_json(path)
        except Exception:
            continue
        if data.get("mode") == "raw-pick-audit" and data.get("photoSummaries"):
            return path
    return candidates[0] if candidates else None


def ensure_model_lab_dirs(model_lab_dir: Path) -> None:
    for relative in (
        "models/musiq",
        "models/clip-iqa",
        "cache",
        "reports",
    ):
        (model_lab_dir / relative).mkdir(parents=True, exist_ok=True)
    write_default_manifest(
        model_lab_dir / "models" / "musiq" / "manifest.json",
        {
            "modelId": "musiq-ava-pyiqa",
            "source": "PyIQA metric name: musiq-ava. Model weights are downloaded by PyIQA into the local torch cache.",
            "paper": "https://arxiv.org/abs/2108.05997",
            "license": "unverified for production redistribution",
            "inputShape": "PyIQA managed",
            "outputMeaning": "Multi-scale image quality/aesthetic score, normalized by this lab to 0-100.",
            "allowedInAppBundle": False,
        },
    )
    write_default_manifest(
        model_lab_dir / "models" / "clip-iqa" / "manifest.json",
        {
            "modelId": "clipiqa-pyiqa",
            "source": "PyIQA metric name: clipiqa. Model weights are downloaded by PyIQA into the local torch cache.",
            "paper": "https://arxiv.org/abs/2207.12396",
            "license": "unverified for production redistribution",
            "inputShape": "PyIQA managed",
            "outputMeaning": "CLIP look-and-feel / image-quality score, normalized by this lab to 0-100.",
            "allowedInAppBundle": False,
        },
    )


def write_default_manifest(path: Path, content: dict[str, Any]) -> None:
    if path.exists():
        return
    content = {
        "schema": MODEL_LAB_SCHEMA_VERSION,
        "createdAt": iso_now(),
        "sha256": None,
        **content,
    }
    save_json(path, content)


def configure_external_caches(model_lab_dir: Path) -> None:
    cache_root = model_lab_dir / "cache"
    env_defaults = {
        "HF_HOME": cache_root / "huggingface",
        "HUGGINGFACE_HUB_CACHE": cache_root / "huggingface" / "hub",
        "TRANSFORMERS_CACHE": cache_root / "huggingface" / "transformers",
        "TORCH_HOME": cache_root / "torch",
        "XDG_CACHE_HOME": cache_root / "xdg",
        "PIP_CACHE_DIR": cache_root / "pip",
    }
    for key, value in env_defaults.items():
        os.environ.setdefault(key, str(value))
        Path(os.environ[key]).mkdir(parents=True, exist_ok=True)


def build_models(
    model_ids: list[str],
    model_lab_dir: Path,
    device: str,
    candidate_max_edge: int,
    baseline_by_id: dict[str, dict[str, Any]],
) -> list[CandidateModel]:
    models: list[CandidateModel] = []
    for model_id in model_ids:
        if model_id == "nima-baseline":
            models.append(NimaBaselineModel(model_lab_dir, device, baseline_by_id, candidate_max_edge))
        elif model_id == "musiq-pyiqa":
            models.append(MusiqPyiqaModel(model_lab_dir, device, candidate_max_edge))
        elif model_id in ("musiq-ava-pyiqa", "musiq-ava"):
            models.append(MusiqAvaPyiqaModel(model_lab_dir, device, candidate_max_edge))
        elif model_id in ("clipiqa-pyiqa", "clip-iqa-pyiqa"):
            models.append(ClipIqaPyiqaModel(model_lab_dir, device, candidate_max_edge))
        elif model_id in ("fused-balanced", "fused-recall"):
            continue
        else:
            raise SystemExit(f"Unknown model id: {model_id}")
    return models


def build_records(
    preview_dir: Path,
    labels_manifest: dict[str, Any],
    baseline_by_id: dict[str, dict[str, Any]],
    limit: int,
    stage: str,
) -> list[PhotoRecord]:
    labels = labels_manifest.get("labels", {})
    source_names = labels_manifest.get("sourceNames", {})
    files = sorted(preview_dir.glob("*.jpg"), key=lambda path: natural_key(path.stem))
    selected_ids: set[str] | None = None
    if stage == "smoke-60":
        labeled_ids = list(labels.keys())
        selected_ids = set(labeled_ids[:30])
        selected_ids.update(path.stem for path in files[:30])
    elif stage == "balanced-labels":
        positives = [photo_id for photo_id, rating in labels.items() if int(rating) >= 3]
        negatives = [photo_id for photo_id, rating in labels.items() if int(rating) < 3]
        positive_target = max(len(negatives), 1)
        step = max(1, len(positives) // positive_target)
        selected_ids = set(negatives)
        selected_ids.update(positives[::step][:positive_target])
    elif stage == "labels-814":
        selected_ids = set(labels.keys())
    elif stage == "radius-3-context":
        selected_ids = select_radius_context(files, set(labels.keys()), radius=3)
    elif stage == "all":
        selected_ids = None

    records: list[PhotoRecord] = []
    for image_path in files:
        photo_id = image_path.stem
        if selected_ids is not None and photo_id not in selected_ids:
            continue
        rating = labels.get(photo_id)
        rating = int(rating) if rating is not None else None
        positive = None if rating is None else rating >= 3
        records.append(PhotoRecord(
            photo_id=photo_id,
            file_name=image_path.name,
            image_path=image_path,
            source_name=source_names.get(photo_id),
            rating=rating,
            positive=positive,
            baseline=baseline_by_id.get(photo_id, {}),
        ))
        if limit > 0 and len(records) >= limit:
            break
    return records


def score_model(
    model: CandidateModel,
    records: list[PhotoRecord],
    cache: dict[str, Any],
    cache_path: Path,
    force: bool,
    cache_save_every: int,
) -> dict[str, CandidateScore]:
    scores: dict[str, CandidateScore] = {}
    try:
        reset_candidate_memory_stats(model)
        model.setup()
        update_candidate_memory_stats(model)
    except Exception as exc:
        error = model.load_error or f"{type(exc).__name__}: {exc}"
        for record in records:
            scores[record.photo_id] = CandidateScore(model.model_id, record.photo_id, "UNAVAILABLE", None, None, error)
        return scores

    uncached_since_save = 0
    for index, record in enumerate(records, start=1):
        cache_key = score_cache_key(model.model_id, model.device, model.candidate_max_edge, record.image_path)
        cached = None if force else cache.get("scores", {}).get(cache_key)
        if cached:
            scores[record.photo_id] = CandidateScore(
                model.model_id,
                record.photo_id,
                cached.get("status", "READY"),
                cached.get("score"),
                cached.get("latencyMs"),
                cached.get("error"),
            )
            continue
        started = time.perf_counter()
        try:
            score = clamp(float(model.score(record.image_path)), 0, 100)
            latency_ms = (time.perf_counter() - started) * 1000
            result = CandidateScore(model.model_id, record.photo_id, "READY", score, latency_ms)
        except Exception as exc:
            latency_ms = (time.perf_counter() - started) * 1000
            result = CandidateScore(
                model.model_id,
                record.photo_id,
                "ERROR",
                None,
                latency_ms,
                f"{type(exc).__name__}: {exc}",
            )
        update_candidate_memory_stats(model)
        scores[record.photo_id] = result
        cache.setdefault("scores", {})[cache_key] = {
            "modelId": result.model_id,
            "photoId": result.photo_id,
            "status": result.status,
            "score": result.score,
            "latencyMs": result.latency_ms,
            "error": result.error,
        }
        uncached_since_save += 1
        if uncached_since_save >= max(1, cache_save_every):
            save_json(cache_path, cache)
            uncached_since_save = 0
        if index % 50 == 0:
            print(f"  {model.model_id}: {index}/{len(records)}")
    if uncached_since_save > 0:
        save_json(cache_path, cache)
    return scores


def reset_candidate_memory_stats(model: CandidateModel) -> None:
    update_candidate_memory_stats(model)
    try:
        import torch  # type: ignore
        if model.device == "cuda" and torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        return


def update_candidate_memory_stats(model: CandidateModel) -> None:
    try:
        import psutil  # type: ignore
        rss = int(psutil.Process(os.getpid()).memory_info().rss)
        model.peak_process_rss_bytes = max(model.peak_process_rss_bytes or 0, rss)
    except Exception:
        pass
    try:
        import torch  # type: ignore
        if model.device == "cuda" and torch.cuda.is_available():
            peak = int(torch.cuda.max_memory_allocated())
            model.peak_cuda_allocated_bytes = max(model.peak_cuda_allocated_bytes or 0, peak)
    except Exception:
        pass


def build_fused_scores(
    records: list[PhotoRecord],
    scores_by_model: dict[str, dict[str, CandidateScore]],
) -> dict[str, dict[str, CandidateScore]]:
    output: dict[str, dict[str, CandidateScore]] = {}
    candidate_sets = [
        ("fused-balanced", {"nima-baseline": 0.25, "musiq-ava-pyiqa": 0.40, "musiq-pyiqa": 0.40, "clipiqa-pyiqa": 0.35}),
        ("fused-recall", {"nima-baseline": 0.15, "musiq-ava-pyiqa": 0.35, "musiq-pyiqa": 0.35, "clipiqa-pyiqa": 0.50}),
    ]
    for fused_id, weights in candidate_sets:
        fused: dict[str, CandidateScore] = {}
        for record in records:
            available: list[tuple[float, float]] = []
            for model_id, weight in weights.items():
                score = scores_by_model.get(model_id, {}).get(record.photo_id)
                if score and score.status == "READY" and score.score is not None:
                    available.append((score.score, weight))
            if not available:
                fused[record.photo_id] = CandidateScore(fused_id, record.photo_id, "UNAVAILABLE", None, None, "No component scores available.")
                continue
            aesthetic = sum(score * weight for score, weight in available) / sum(weight for _, weight in available)
            final = fused_rank_score(record, aesthetic)
            fused[record.photo_id] = CandidateScore(fused_id, record.photo_id, "READY", final, 0)
        output[fused_id] = fused
    return output


def fused_rank_score(record: PhotoRecord, aesthetic: float) -> float:
    baseline = record.baseline
    technical = numeric(baseline.get("technical"), 50)
    scene = numeric(baseline.get("scene"), 50)
    overall = numeric(baseline.get("overall"), 50)
    focus_reliability = numeric(baseline.get("focusReliability"), 0.5) * 100
    issue_penalty = 28 if baseline.get("issueCodes") else 0
    hard_penalty = 100 if baseline.get("hardIssueCodes") else 0
    exclusion_penalty = 32 if "FOCUS_FAIL" in (baseline.get("exclusionReasons") or []) else 0
    score = (
        aesthetic * 0.42 +
        min(technical, 70) * 0.24 +
        scene * 0.16 +
        overall * 0.12 +
        focus_reliability * 0.06 -
        issue_penalty -
        hard_penalty -
        exclusion_penalty
    )
    return clamp(score, 0, 100)


def evaluate_model(
    records: list[PhotoRecord],
    model_id: str,
    scores: dict[str, CandidateScore],
    ratios: list[float],
    supervised_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    labeled = [record for record in records if record.positive is not None]
    positives = [record for record in labeled if record.positive is True]
    negatives = [record for record in labeled if record.positive is False]
    ready_scores = [score for score in scores.values() if score.status == "READY" and score.score is not None]
    status_counts: dict[str, int] = {}
    for score in scores.values():
        status_counts[score.status] = status_counts.get(score.status, 0) + 1

    ratio_metrics = {}
    for ratio in ratios:
        picked = pick_top_records(records, scores, ratio)
        ratio_metrics[str(ratio)] = evaluate_picks(records, picked, positives, negatives, supervised_groups)

    return {
        "statusCounts": status_counts,
        "scoreDistribution": distribution([score.score for score in ready_scores]),
        "latencyMs": distribution([score.latency_ms for score in ready_scores]),
        "rankQuality": rank_quality(labeled, scores),
        "ratios": ratio_metrics,
        "errors": sample_errors(scores),
    }


def pick_top_records(
    records: list[PhotoRecord],
    scores: dict[str, CandidateScore],
    ratio: float,
) -> set[str]:
    candidates = [record for record in records if is_usable_for_offline_pick(record)]
    target = max(0, math.ceil(len(candidates) * ratio))
    ranked = sorted(
        candidates,
        key=lambda record: scores.get(record.photo_id).score if scores.get(record.photo_id) and scores[record.photo_id].score is not None else -1,
        reverse=True,
    )
    return {record.photo_id for record in ranked[:target]}


def is_usable_for_offline_pick(record: PhotoRecord) -> bool:
    baseline = record.baseline
    if baseline.get("status") and baseline.get("status") != "DONE":
        return False
    if baseline.get("hardIssueCodes"):
        return False
    if baseline.get("issueCodes"):
        return False
    if "FOCUS_FAIL" in (baseline.get("exclusionReasons") or []):
        return False
    if numeric(baseline.get("technical"), 50) < 15:
        return False
    return True


def evaluate_picks(
    records: list[PhotoRecord],
    picked: set[str],
    positives: list[PhotoRecord],
    negatives: list[PhotoRecord],
    supervised_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    picked_positive = [record for record in positives if record.photo_id in picked]
    picked_negative = [record for record in negatives if record.photo_id in picked]
    adjacent_pairs = selected_adjacent_pairs(records, picked)
    group_metrics = duplicate_group_metrics(picked, positives, supervised_groups)
    return {
        "picked": len(picked),
        "pickedPositive": len(picked_positive),
        "pickedNegative": len(picked_negative),
        "recall": safe_div(len(picked_positive), len(positives)),
        "negativePickRate": safe_div(len(picked_negative), len(negatives)),
        "precisionOnLabeled": safe_div(len(picked_positive), len(picked_positive) + len(picked_negative)),
        "selectedAdjacentPairs": len(adjacent_pairs),
        "selectedAdjacentSamples": adjacent_pairs[:12],
        **group_metrics,
        "falseNegativeSamples": [
            sample_record(record) for record in positives if record.photo_id not in picked
        ][:20],
    }


def duplicate_group_metrics(
    picked: set[str],
    positives: list[PhotoRecord],
    supervised_groups: list[dict[str, Any]],
) -> dict[str, Any]:
    positive_ids = {record.photo_id for record in positives}
    positive_groups = [group for group in supervised_groups if int(group.get("positiveCount") or 0) > 0]
    groups_without_pick = 0
    groups_with_multiple_picks = 0
    covered_positive_ids: set[str] = set()
    for group in positive_groups:
        photos = group.get("photos") or []
        group_ids = {photo.get("id") for photo in photos if photo.get("id")}
        picked_in_group = group_ids.intersection(picked)
        positive_in_group = group_ids.intersection(positive_ids)
        if picked_in_group:
            covered_positive_ids.update(positive_in_group)
        else:
            groups_without_pick += 1
        if len(picked_in_group) > 1:
            groups_with_multiple_picks += 1
    own_picked_positive_ids = positive_ids.intersection(picked)
    frame_or_group_covered = own_picked_positive_ids.union(covered_positive_ids)
    return {
        "positiveDuplicateGroups": len(positive_groups),
        "positiveDuplicateGroupCoverage": safe_div(len(positive_groups) - groups_without_pick, len(positive_groups)),
        "positiveDuplicateGroupsWithoutPick": groups_without_pick,
        "positiveDuplicateGroupsWithMultiplePicks": groups_with_multiple_picks,
        "positiveFrameOrGroupCoverage": safe_div(len(frame_or_group_covered), len(positive_ids)),
    }


def rank_quality(labeled: list[PhotoRecord], scores: dict[str, CandidateScore]) -> dict[str, Any]:
    pairs = [
        (record, scores.get(record.photo_id))
        for record in labeled
        if scores.get(record.photo_id) and scores[record.photo_id].score is not None
    ]
    positives = [(record, score) for record, score in pairs if record.positive is True]
    negatives = [(record, score) for record, score in pairs if record.positive is False]
    if not positives or not negatives:
        return {"auc": None, "positiveMean": None, "negativeMean": None, "separation": None}
    pos_scores = [float(score.score) for _, score in positives if score.score is not None]
    neg_scores = [float(score.score) for _, score in negatives if score.score is not None]
    wins = 0.0
    total = 0
    for pos in pos_scores:
        for neg in neg_scores:
            total += 1
            if pos > neg:
                wins += 1
            elif pos == neg:
                wins += 0.5
    return {
        "auc": safe_div(wins, total),
        "positiveMean": statistics.mean(pos_scores),
        "negativeMean": statistics.mean(neg_scores),
        "separation": statistics.mean(pos_scores) - statistics.mean(neg_scores),
    }


def selected_adjacent_pairs(records: list[PhotoRecord], picked: set[str]) -> list[dict[str, Any]]:
    selected = sorted(
        [record for record in records if record.photo_id in picked],
        key=lambda record: natural_key(record.photo_id),
    )
    pairs: list[dict[str, Any]] = []
    for left, right in zip(selected, selected[1:]):
        left_number = trailing_number(left.photo_id)
        right_number = trailing_number(right.photo_id)
        if left_number is None or right_number is None:
            continue
        gap = abs(right_number - left_number)
        if gap <= 3 and same_prefix(left.photo_id, right.photo_id):
            pairs.append({
                "left": left.photo_id,
                "right": right.photo_id,
                "gap": gap,
                "leftRating": left.rating,
                "rightRating": right.rating,
            })
    return pairs


def choose_recommendation(
    metrics: dict[str, Any],
    manifests: list[dict[str, Any]],
    baseline_model_id: str,
) -> dict[str, Any]:
    baseline = metrics.get(baseline_model_id, {})
    baseline_ratio = baseline.get("ratios", {}).get("0.5", {})
    baseline_recall = numeric(baseline_ratio.get("recall"), 0)
    baseline_adjacent = numeric(baseline_ratio.get("selectedAdjacentPairs"), 0)
    best_id = baseline_model_id
    best_gain = 0.0
    best_payload: dict[str, Any] = {}
    for model_id, item in metrics.items():
        ratio = item.get("ratios", {}).get("0.5", {})
        recall = numeric(ratio.get("recall"), 0)
        adjacent = numeric(ratio.get("selectedAdjacentPairs"), 10**9)
        gain = recall - baseline_recall
        if gain > best_gain and adjacent <= baseline_adjacent:
            best_id = model_id
            best_gain = gain
            best_payload = ratio

    manifest_by_id = {item.get("modelId"): item for item in manifests}
    best_manifest = manifest_by_id.get(best_id, {})
    package_size = numeric(best_manifest.get("packageSizeBytes"), 0)
    load_error = best_manifest.get("loadError")
    if load_error:
        decision = "keep-nima-and-tune-rules"
        reason = f"Best candidate {best_id} is not runnable: {load_error}"
    elif best_id == baseline_model_id or best_gain < 0.05:
        decision = "keep-nima-and-tune-rules"
        reason = "No candidate improved labeled positive recall by at least 5 percentage points without increasing adjacent duplicate pollution."
    elif package_size > 150 * 1024 * 1024:
        decision = "optional-high-accuracy-pack"
        reason = "Candidate improves recall but is too large for the default app bundle."
    elif "clip" in best_id:
        decision = "add-clip-aesthetic-as-optional-or-fused-context"
        reason = "CLIP-style score improved recall without duplicate regression."
    elif "musiq" in best_id:
        decision = "augment-nima-with-musiq"
        reason = "MUSIQ score improved recall without duplicate regression."
    else:
        decision = "use-fused-scorer-with-technical-gates"
        reason = "Fused scoring improved recall while keeping hard technical gates."

    return {
        "decision": decision,
        "bestCandidate": best_id,
        "baselineRecallAt50": baseline_recall,
        "bestRecallAt50": best_payload.get("recall"),
        "recallGainAt50": best_gain,
        "reason": reason,
        "productionChangesNeeded": production_changes_for_decision(decision, best_id),
    }


def production_changes_for_decision(decision: str, best_id: str) -> list[str]:
    if decision == "keep-nima-and-tune-rules":
        return [
            "Do not add MUSIQ or CLIP-IQA to the production bundle.",
            "Tune duplicate/burst grouping and AI Pick representative selection using the audit output.",
        ]
    if decision == "optional-high-accuracy-pack":
        return [
            f"Keep {best_id} outside the default installer.",
            "Add a user-enabled high-accuracy scoring pack with explicit download/license text.",
            "Keep technical hard gates before aesthetic ranking.",
        ]
    if decision == "augment-nima-with-musiq":
        return [
            "Extend AiAestheticScore with a MUSIQ component and model status.",
            "Update PhotoScore weights so MUSIQ affects aesthetic/scene ranking but cannot override focus/eye hard gates.",
            "Re-run package-size and latency checks before bundling.",
        ]
    if decision == "add-clip-aesthetic-as-optional-or-fused-context":
        return [
            "Add CLIP aesthetic/context score as optional high-accuracy ranking input.",
            "Use CLIP score mainly for back-view/environmental portraits and scene-fit ranking.",
            "Keep NIMA or heuristic scoring as the lightweight default fallback.",
        ]
    return [
        "Implement fused scorer only after metric review.",
        "Increment AI/photo score cache versions after production scoring changes.",
    ]


def build_failure_samples(
    records: list[PhotoRecord],
    scores_by_model: dict[str, dict[str, CandidateScore]],
    metrics: dict[str, Any],
) -> dict[str, Any]:
    samples: dict[str, Any] = {}
    for model_id, model_scores in scores_by_model.items():
        ranked = sorted(
            [record for record in records if record.positive is True],
            key=lambda record: model_scores.get(record.photo_id).score if model_scores.get(record.photo_id) and model_scores[record.photo_id].score is not None else -1,
        )
        samples[model_id] = {
            "lowestScoredPositives": [
                {
                    **sample_record(record),
                    "score": model_scores.get(record.photo_id).score if model_scores.get(record.photo_id) else None,
                }
                for record in ranked[:12]
            ],
            "errors": metrics.get(model_id, {}).get("errors", []),
        }
    return samples


def write_csv(path: Path, records: list[PhotoRecord], scores_by_model: dict[str, dict[str, CandidateScore]]) -> None:
    model_ids = list(scores_by_model.keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "photo_id",
            "file_name",
            "rating",
            "positive",
            "baseline_picked",
            "baseline_overall",
            "baseline_technical",
            "baseline_aesthetic",
            *[f"{model_id}_status" for model_id in model_ids],
            *[f"{model_id}_score" for model_id in model_ids],
            *[f"{model_id}_latency_ms" for model_id in model_ids],
        ])
        for record in records:
            writer.writerow([
                record.photo_id,
                record.file_name,
                record.rating,
                record.positive,
                record.baseline.get("picked"),
                record.baseline.get("overall"),
                record.baseline.get("technical"),
                record.baseline.get("aesthetic"),
                *[(scores_by_model[model_id].get(record.photo_id).status if scores_by_model[model_id].get(record.photo_id) else "MISSING") for model_id in model_ids],
                *[(scores_by_model[model_id].get(record.photo_id).score if scores_by_model[model_id].get(record.photo_id) else None) for model_id in model_ids],
                *[(scores_by_model[model_id].get(record.photo_id).latency_ms if scores_by_model[model_id].get(record.photo_id) else None) for model_id in model_ids],
            ])


def write_summary(path: Path, result: dict[str, Any]) -> None:
    lines = [
        "# FrameCull AI Aesthetic Candidate Lab",
        "",
        f"- Created: `{result['createdAt']}`",
        f"- Stage: `{result['stage']}`",
        f"- Records: `{result['records']['total']}` total, `{result['records']['labeled']}` labeled, `{result['records']['positive']}` positive, `{result['records']['negative']}` negative",
        f"- Decision: **{result['recommendation']['decision']}**",
        f"- Best candidate: `{result['recommendation']['bestCandidate']}`",
        f"- Reason: {result['recommendation']['reason']}",
        "",
        "## Metrics",
        "",
        "| Model | Ready | AUC | Recall @38 | Recall @50 | Recall @60 | Group cov @50 | Multi groups @50 | Neg pick @50 | Adjacent pairs @50 | Avg latency ms |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for model_id, metrics in result["metrics"].items():
        ratios = metrics.get("ratios", {})
        rank = metrics.get("rankQuality", {})
        latency = metrics.get("latencyMs", {})
        lines.append(
            f"| `{model_id}` | {metrics.get('statusCounts', {}).get('READY', 0)} | "
            f"{fmt(rank.get('auc'))} | {fmt(ratios.get('0.38', {}).get('recall'))} | "
            f"{fmt(ratios.get('0.5', {}).get('recall'))} | {fmt(ratios.get('0.6', {}).get('recall'))} | "
            f"{fmt(ratios.get('0.5', {}).get('positiveDuplicateGroupCoverage'))} | "
            f"{ratios.get('0.5', {}).get('positiveDuplicateGroupsWithMultiplePicks', '')} | "
            f"{fmt(ratios.get('0.5', {}).get('negativePickRate'))} | "
            f"{ratios.get('0.5', {}).get('selectedAdjacentPairs', '')} | {fmt(latency.get('average'))} |"
        )
    lines.extend([
        "",
        "## Candidate Manifests",
        "",
    ])
    for manifest in result["candidateManifests"]:
        lines.extend([
            f"### {manifest.get('modelId')}",
            f"- Output: {manifest.get('outputMeaning')}",
            f"- License risk: `{manifest.get('licenseRisk')}`",
            f"- Package size: `{manifest.get('packageSizeBytes')}` bytes",
            f"- Peak process RSS: `{manifest.get('peakProcessRssBytes')}` bytes",
            f"- Peak CUDA allocated: `{manifest.get('peakCudaAllocatedBytes')}` bytes",
            f"- Load error: `{manifest.get('loadError') or 'none'}`",
            "",
        ])
    lines.extend([
        "## Production Changes Needed",
        "",
        *[f"- {item}" for item in result["recommendation"].get("productionChangesNeeded", [])],
        "",
        "## Notes",
        "",
        "- XMP ratings are used only as evaluation labels, never as ranking input.",
        "- Candidate model files remain outside the app bundle until license, size, and metrics are proven.",
        "- Focus/blur/AI hard gates remain ahead of aesthetic score in every fused strategy.",
    ])
    path.write_text("\n".join(lines), encoding="utf-8")


def normalize_metric_score(model_id: str, value: float) -> float:
    if not math.isfinite(value):
        raise RuntimeError(f"Non-finite metric output: {value}")
    if model_id in ("musiq-pyiqa", "musiq-ava-pyiqa"):
        # PyIQA MUSIQ-AVA is AVA-style 1-10; some MUSIQ variants are already 0-100.
        if value <= 1.5:
            return value * 100
        if value <= 10:
            return value * 10
        return value
    if model_id == "clipiqa-pyiqa":
        # CLIP-IQA is commonly 0-1.
        return value * 100 if value <= 1.5 else value
    return value


def prepare_candidate_image(image_path: Path, model_lab_dir: Path, max_edge: int) -> Path:
    if max_edge <= 0:
        return image_path
    stat = image_path.stat()
    cache_dir = model_lab_dir / "cache" / f"candidate-previews-{max_edge}"
    cache_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(f"{image_path}|{stat.st_size}|{int(stat.st_mtime_ns)}|{max_edge}".encode("utf-8")).hexdigest()[:16]
    output_path = cache_dir / f"{image_path.stem}-{digest}.jpg"
    if output_path.exists() and output_path.stat().st_size > 0:
        return output_path
    with Image.open(image_path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        width, height = image.size
        edge = max(width, height)
        if edge > max_edge:
            scale = max_edge / edge
            image = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)
        image.save(output_path, format="JPEG", quality=92, optimize=True)
    return output_path


def score_cache_key(model_id: str, device: str, candidate_max_edge: int, image_path: Path) -> str:
    stat = image_path.stat()
    payload = f"{SCORE_CACHE_VERSION}|{model_id}|{device}|{candidate_max_edge}|{image_path}|{stat.st_size}|{int(stat.st_mtime_ns)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def select_radius_context(files: list[Path], labeled_ids: set[str], radius: int) -> set[str]:
    labels = [(photo_id, same_prefix_key(photo_id), trailing_number(photo_id)) for photo_id in labeled_ids]
    selected: set[str] = set()
    for path in files:
        photo_id = path.stem
        if photo_id in labeled_ids:
            selected.add(photo_id)
            continue
        number = trailing_number(photo_id)
        if number is None:
            continue
        prefix = same_prefix_key(photo_id)
        if any(label_prefix == prefix and label_number is not None and abs(label_number - number) <= radius for _, label_prefix, label_number in labels):
            selected.add(photo_id)
    return selected


def sample_errors(scores: dict[str, CandidateScore]) -> list[dict[str, Any]]:
    errors = []
    for score in scores.values():
        if score.status in ("ERROR", "UNAVAILABLE"):
            errors.append({
                "photoId": score.photo_id,
                "status": score.status,
                "error": score.error,
            })
        if len(errors) >= 12:
            break
    return errors


def sample_record(record: PhotoRecord) -> dict[str, Any]:
    return {
        "id": record.photo_id,
        "rating": record.rating,
        "fileName": record.file_name,
        "sourceName": record.source_name,
        "overall": record.baseline.get("overall"),
        "technical": record.baseline.get("technical"),
        "aesthetic": record.baseline.get("aesthetic"),
        "issueCodes": record.baseline.get("issueCodes"),
        "exclusionReasons": record.baseline.get("exclusionReasons"),
    }


def distribution(values: Iterable[float | None]) -> dict[str, float | None]:
    clean = sorted(float(value) for value in values if value is not None and math.isfinite(float(value)))
    if not clean:
        return {"min": None, "p10": None, "p25": None, "median": None, "p75": None, "p90": None, "max": None, "average": None}
    return {
        "min": clean[0],
        "p10": percentile(clean, 0.10),
        "p25": percentile(clean, 0.25),
        "median": percentile(clean, 0.50),
        "p75": percentile(clean, 0.75),
        "p90": percentile(clean, 0.90),
        "max": clean[-1],
        "average": statistics.mean(clean),
    }


def percentile(sorted_values: list[float], ratio: float) -> float:
    if not sorted_values:
        return 0
    index = min(len(sorted_values) - 1, max(0, round((len(sorted_values) - 1) * ratio)))
    return sorted_values[index]


def parse_ratios(value: str) -> list[float]:
    return [clamp(float(part.strip()), 0.01, 0.99) for part in value.split(",") if part.strip()]


def trailing_number(value: str) -> int | None:
    digits = ""
    for char in reversed(value):
        if char.isdigit():
            digits = char + digits
        elif digits:
            break
    return int(digits) if digits else None


def same_prefix(left: str, right: str) -> bool:
    return same_prefix_key(left) == same_prefix_key(right)


def same_prefix_key(value: str) -> str:
    index = len(value)
    while index > 0 and value[index - 1].isdigit():
        index -= 1
    return value[:index]


def natural_key(value: str) -> tuple[str, int]:
    return (same_prefix_key(value), trailing_number(value) or 0)


def directory_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            total += child.stat().st_size
    return total


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def timestamp_for_filename() -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime())


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def numeric(value: Any, fallback: float) -> float:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else fallback


def fmt(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return f"{value:.4f}"
    return str(value)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception:
        traceback.print_exc()
        raise
