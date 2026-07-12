#!/usr/bin/env python
"""Train FrameCull Pro Semantic Student V2/V3.

This is the grounded-teacher student path for Semantic Teacher Lab v1. It uses:

- semantic teacher JSONL: grounded VLM labels
- quality teacher NPZ: MUSIQ scores, CLIP[512], DINOv2 dino[768]
- 384px student previews

Ratings are not used here. Persona/ranking fine-tuning remains a separate step.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn as nn
from PIL import Image, ImageFile
from scipy.stats import pearsonr, spearmanr
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

import timm
from semantic_teacher_schema import SCENE_TYPES, validate_record
from train_distill_backbone import IMAGENET_MEAN, IMAGENET_STD

ImageFile.LOAD_TRUNCATED_IMAGES = True

LAB = "/data/FrameCullModelLab"
QUALITY_TEACHER_DIR = f"{LAB}/features/teacher"
PREVIEW_DIRS = {
    "camera": f"{LAB}/incoming/camera-previews-384",
    "audit3groups": f"{LAB}/incoming/raw-audit-previews",
}
QUALITY_TEACHER_NPZ = {
    "camera": f"{QUALITY_TEACHER_DIR}/teacher-camera.npz",
    "audit3groups": f"{QUALITY_TEACHER_DIR}/teacher-audit3groups.npz",
}

SCENE_LABELS = sorted(SCENE_TYPES)
SCALAR_HEADS = [
    "semanticKeepScore",
    "faceValidityScore",
    "falseFaceRisk",
    "compositionScore",
    "momentScore",
    "lightingMoodScore",
]

TARGET_HIGH_RISK_SCENES = {
    "landscape",
    "documentary_moment",
    "event",
    "product_object",
}

EXPECTED_V12_MERGED_TEACHER_SHA256 = "04f5527f8bc6922a743d20cefd5b537c6cf87882d119d20581b2b81985c62059"
FALSE_FACE_HARD_NEGATIVE_RISK_THRESHOLD = 0.5
FACE_LOSS_FALSE_POSITIVE_PENALTY = 2.75
FALSE_FACE_RISK_UNDERESTIMATE_PENALTY = 2.75
FACE_LOSS_MAX_WEIGHT = 10.0
SAMPLER_HARD_NEGATIVE_WEIGHT = 5.0
SAMPLER_TARGET_SCENE_MULTIPLIER = 2.0


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_nonempty_lines(path: str | Path) -> int:
    count = 0
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if line.strip():
                count += 1
    return count


@dataclass
class Normalizer:
    mean: float
    std: float

    def encode(self, value: torch.Tensor) -> torch.Tensor:
        return (value - self.mean) / (self.std + 1e-6)

    def decode(self, value: np.ndarray) -> np.ndarray:
        return value * (self.std + 1e-6) + self.mean


@dataclass
class SemanticItem:
    dataset: str
    stem: str
    path: str
    teacher: dict[str, Any]
    musiq_aes: float
    clip: np.ndarray
    dino: np.ndarray


@dataclass
class FalseFaceRegionItem:
    dataset: str
    stem: str
    path: str
    teacher: dict[str, Any]
    region: list[float]
    evidence: str


class SemanticDataset(Dataset):
    def __init__(self, items: list[SemanticItem], input_size: int = 384, augment: bool = False):
        self.items = items
        self.input_size = input_size
        self.augment = augment

    def __len__(self) -> int:
        return len(self.items)

    def _load(self, path: str) -> torch.Tensor:
        try:
            image = Image.open(path).convert("RGB")
            image = image.resize((self.input_size, self.input_size), Image.BILINEAR)
            arr = np.asarray(image, dtype=np.float32) / 255.0
            tensor = torch.from_numpy(arr).permute(2, 0, 1)
            if tensor.shape != (3, self.input_size, self.input_size):
                raise ValueError(f"bad image tensor shape {tuple(tensor.shape)}")
            return tensor
        except Exception as error:
            print(f"[warn] load fail {path}: {error}", flush=True)
            return torch.full((3, self.input_size, self.input_size), 0.5)

    def __getitem__(self, index: int):
        item = self.items[index]
        teacher = item.teacher
        px = self._load(item.path)
        if self.augment and torch.rand(1).item() < 0.5:
            px = torch.flip(px, dims=[2])
        scene_index = SCENE_LABELS.index(str(teacher["sceneType"]))
        scalars = [float(teacher[name]) for name in SCALAR_HEADS]
        false_face_risk = float(teacher.get("falseFaceRisk", max(0.0, 1.0 - float(teacher.get("faceValidityScore", 0.5)))))
        face_sample_weight = face_loss_weight(teacher)
        return (
            px,
            torch.tensor(float(item.musiq_aes), dtype=torch.float32),
            torch.tensor(scene_index, dtype=torch.long),
            torch.tensor(scalars, dtype=torch.float32),
            torch.tensor(false_face_risk, dtype=torch.float32),
            torch.tensor(face_sample_weight, dtype=torch.float32),
            torch.from_numpy(item.clip).float(),
            torch.from_numpy(item.dino).float(),
        )


class FalseFaceRegionDataset(Dataset):
    def __init__(self, items: list[FalseFaceRegionItem], input_size: int = 384, augment: bool = False, context_pad: float = 0.16):
        self.items = items
        self.input_size = input_size
        self.augment = augment
        self.context_pad = context_pad

    def __len__(self) -> int:
        return len(self.items)

    def _crop(self, path: str, region: list[float]) -> torch.Tensor:
        try:
            image = Image.open(path).convert("RGB")
            width, height = image.size
            values = [float(value) for value in region]
            x1, y1, x2, y2 = values
            if max(values) <= 1.5:
                x1, x2 = x1 * width, x2 * width
                y1, y2 = y1 * height, y2 * height
            left, right = sorted((x1, x2))
            top, bottom = sorted((y1, y2))
            box_w = max(1.0, right - left)
            box_h = max(1.0, bottom - top)
            pad_x = box_w * self.context_pad
            pad_y = box_h * self.context_pad
            left = max(0, int(round(left - pad_x)))
            top = max(0, int(round(top - pad_y)))
            right = min(width, int(round(right + pad_x)))
            bottom = min(height, int(round(bottom + pad_y)))
            if right - left < 8 or bottom - top < 8:
                raise ValueError(f"region too small after clamp: {(left, top, right, bottom)}")
            crop = image.crop((left, top, right, bottom))
            crop = crop.resize((self.input_size, self.input_size), Image.BILINEAR)
            arr = np.asarray(crop, dtype=np.float32) / 255.0
            tensor = torch.from_numpy(arr).permute(2, 0, 1)
            if tensor.shape != (3, self.input_size, self.input_size):
                raise ValueError(f"bad crop tensor shape {tuple(tensor.shape)}")
            return tensor
        except Exception as error:
            print(f"[warn] false-face region crop fail {path}: {error}", flush=True)
            return torch.full((3, self.input_size, self.input_size), 0.5)

    def __getitem__(self, index: int):
        item = self.items[index]
        px = self._crop(item.path, item.region)
        if self.augment and torch.rand(1).item() < 0.5:
            px = torch.flip(px, dims=[2])
        return px


class SemanticStudent(nn.Module):
    """Shared backbone plus only the heads approved by the mapping table."""

    def __init__(
        self,
        backbone_name: str,
        *,
        clip_dim: int = 512,
        dino_dim: int = 768,
        scene_count: int = len(SCENE_LABELS),
        input_size: int = 384,
        pretrained: bool = True,
    ):
        super().__init__()
        kw = dict(pretrained=pretrained, num_classes=0, global_pool="avg")
        if "deit" in backbone_name or "vit" in backbone_name:
            kw["img_size"] = input_size
        self.backbone = timm.create_model(backbone_name, **kw)
        self.feat_dim = int(self.backbone.num_features)
        self.backbone_name = backbone_name
        self.input_size = input_size
        self.clip_dim = int(clip_dim)
        self.dino_dim = int(dino_dim)
        self.scene_count = int(scene_count)

        def mlp(out_dim: int) -> nn.Sequential:
            return nn.Sequential(
                nn.Linear(self.feat_dim, 256),
                nn.GELU(),
                nn.Dropout(0.1),
                nn.Linear(256, out_dim),
            )

        self.aesthetic_head = mlp(1)
        self.scene_head = mlp(self.scene_count)
        self.semantic_keep_head = mlp(1)
        self.face_validity_head = mlp(1)
        self.false_face_risk_head = mlp(1)
        self.composition_head = mlp(1)
        self.moment_head = mlp(1)
        self.lighting_head = mlp(1)
        self.clip_head = mlp(self.clip_dim)
        self.dino_head = mlp(self.dino_dim)

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        feat = self.backbone(x)
        return {
            "aesthetic": self.aesthetic_head(feat).squeeze(-1),
            "scene_logits": self.scene_head(feat),
            "semantic_keep": self.semantic_keep_head(feat).squeeze(-1),
            "face_validity": self.face_validity_head(feat).squeeze(-1),
            "false_face_risk": self.false_face_risk_head(feat).squeeze(-1),
            "composition": self.composition_head(feat).squeeze(-1),
            "moment": self.moment_head(feat).squeeze(-1),
            "lighting": self.lighting_head(feat).squeeze(-1),
            "clip": self.clip_head(feat),
            "dino": self.dino_head(feat),
        }


def stem_key(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    text = str(value).strip().strip('"').strip("'")
    if not text:
        return ""
    key = Path(text).stem.lower()
    # Some generated teacher JPEGs may be named like DSC0001.ARW.jpg; index both
    # the outer stem and the original camera stem.
    while True:
        inner = Path(key).stem.lower()
        if inner == key:
            break
        key = inner
    return key


def record_aliases(record: dict[str, Any]) -> set[str]:
    aliases: set[str] = set()
    for field in (
        "photoId",
        "imagePath",
        "teacherImagePath",
        "studentPreviewPath",
        "sourcePath",
        "importPath",
    ):
        key = stem_key(record.get(field))
        if key:
            aliases.add(key)
    return aliases


def index_previews(preview_dir: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    if not preview_dir.exists():
        return index
    for path in preview_dir.iterdir():
        if not path.is_file() or path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        key = stem_key(path.name)
        if key and key not in index:
            index[key] = path
    return index


def iter_jsonl(path: Path, *, allow_flat_scalar: bool = False):
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            record = json.loads(text)
            errors = validate_record(record, allow_flat_scalar=allow_flat_scalar)
            if errors:
                raise ValueError(f"{path}:{line_no} schema errors: {errors[:6]}")
            yield record


def load_semantic_teacher(
    path: Path,
    *,
    allow_flat_scalar: bool = False,
) -> tuple[dict[tuple[str, str], dict[str, Any]], dict[str, dict[str, Any]]]:
    by_dataset_stem: dict[tuple[str, str], dict[str, Any]] = {}
    by_stem: dict[str, dict[str, Any]] = {}
    dataset_collisions: set[tuple[str, str]] = set()
    global_collisions: set[str] = set()
    records = 0
    alias_count = 0
    for record in iter_jsonl(path, allow_flat_scalar=allow_flat_scalar):
        records += 1
        dataset = str(record.get("dataset") or "unknown")
        for key in record_aliases(record):
            alias_count += 1
            ds_key = (dataset, key)
            existing = by_dataset_stem.get(ds_key)
            if existing is not None and existing.get("photoId") != record.get("photoId"):
                dataset_collisions.add(ds_key)
            else:
                by_dataset_stem[ds_key] = record
            existing_global = by_stem.get(key)
            if existing_global is not None and (
                existing_global.get("dataset") != dataset or existing_global.get("photoId") != record.get("photoId")
            ):
                global_collisions.add(key)
            else:
                by_stem[key] = record
    for key in dataset_collisions:
        by_dataset_stem.pop(key, None)
    for key in global_collisions:
        by_stem.pop(key, None)
    print(
        "[teacher] "
        f"records={records} aliases={alias_count} "
        f"dataset_aliases={len(by_dataset_stem)} unique_aliases={len(by_stem)} "
        f"dataset_collisions={len(dataset_collisions)} global_collisions={len(global_collisions)}",
        flush=True,
    )
    return by_dataset_stem, by_stem


def load_quality_npz(path: Path, *, require_dino: bool = True) -> dict[str, dict[str, Any]]:
    data = np.load(path, allow_pickle=True)
    required = ["stems", "musiq_aes", "clip"]
    for name in required:
        if name not in data.files:
            raise RuntimeError(f"{path} missing required field {name}")
    if require_dino and "dino" not in data.files:
        raise RuntimeError(f"{path} missing dino[768]; Phase 2.5 is incomplete")
    dino = data["dino"] if "dino" in data.files else np.zeros((len(data["stems"]), 0), dtype=np.float32)
    if require_dino and dino.shape[1] != 768:
        raise RuntimeError(f"{path} dino must be [N,768], got {list(dino.shape)}")
    out: dict[str, dict[str, Any]] = {}
    for idx, stem in enumerate(data["stems"]):
        key = stem_key(str(stem))
        out[key] = {
            "musiq_aes": float(data["musiq_aes"][idx]),
            "clip": data["clip"][idx].astype(np.float32),
            "dino": dino[idx].astype(np.float32),
        }
    return out


def build_items(args) -> list[SemanticItem]:
    by_dataset_stem, by_unique_stem = load_semantic_teacher(
        Path(args.semantic_teacher),
        allow_flat_scalar=args.allow_flat_scalar_teacher,
    )
    items: list[SemanticItem] = []
    stats: dict[str, dict[str, Any]] = {}
    quality_root = Path(args.quality_teacher_dir)
    npz_paths = {
        "camera": quality_root / "teacher-camera.npz",
        "audit3groups": quality_root / "teacher-audit3groups.npz",
    }
    preview_dirs = {
        "camera": Path(args.camera_previews),
        "audit3groups": Path(args.audit_previews),
    }
    if args.include_five_mountain:
        npz_paths["five_mountain"] = quality_root / "teacher-five-mountain.npz"
        preview_dirs["five_mountain"] = Path(args.five_mountain_previews)
    for dataset, npz_path in npz_paths.items():
        quality = load_quality_npz(npz_path, require_dino=not args.allow_missing_dino)
        preview_dir = preview_dirs[dataset]
        preview_index = index_previews(preview_dir)
        stats[dataset] = {
            "quality": len(quality),
            "previews": len(preview_index),
            "matched": 0,
            "missingTeacher": 0,
            "missingPreview": 0,
        }
        missing_teacher_examples: list[str] = []
        missing_preview_examples: list[str] = []
        for stem, row in quality.items():
            teacher = by_dataset_stem.get((dataset, stem))
            if teacher is None and not args.strict_dataset_match:
                teacher = by_unique_stem.get(stem)
            if teacher is None:
                stats[dataset]["missingTeacher"] += 1
                if len(missing_teacher_examples) < 12:
                    missing_teacher_examples.append(stem)
                continue
            preview_path = preview_index.get(stem)
            if preview_path is None:
                stats[dataset]["missingPreview"] += 1
                if len(missing_preview_examples) < 12:
                    missing_preview_examples.append(stem)
                continue
            items.append(SemanticItem(dataset, stem, str(preview_path), teacher, row["musiq_aes"], row["clip"], row["dino"]))
            stats[dataset]["matched"] += 1
        if missing_teacher_examples:
            stats[dataset]["missingTeacherExamples"] = missing_teacher_examples
        if missing_preview_examples:
            stats[dataset]["missingPreviewExamples"] = missing_preview_examples
    if args.limit:
        items = items[: args.limit]
    print(f"[data] stats={json.dumps(stats, ensure_ascii=False)} total={len(items)}", flush=True)
    if not items:
        raise RuntimeError("No matched semantic student training items")
    return items


def verdict_bool(value: Any, default: bool = False) -> bool:
    return teacher_bool({"value": value}, "value", default)


def false_face_region_verdicts(teacher: dict[str, Any]) -> list[dict[str, Any]]:
    verdicts = []
    for verdict in teacher.get("faceRegionVerdicts") or []:
        if not isinstance(verdict, dict):
            continue
        if verdict_bool(verdict.get("isRealHumanFace"), default=True):
            continue
        region = verdict.get("region")
        if not isinstance(region, list) or len(region) != 4:
            continue
        try:
            values = [float(value) for value in region]
        except (TypeError, ValueError):
            continue
        if not all(np.isfinite(values)):
            continue
        verdicts.append(verdict)
    return verdicts


def build_false_face_region_items(items: list[SemanticItem], *, max_regions_per_image: int = 3) -> list[FalseFaceRegionItem]:
    region_items: list[FalseFaceRegionItem] = []
    for item in items:
        for verdict in false_face_region_verdicts(item.teacher)[:max_regions_per_image]:
            region_items.append(FalseFaceRegionItem(
                dataset=item.dataset,
                stem=item.stem,
                path=item.path,
                teacher=item.teacher,
                region=[float(value) for value in verdict["region"]],
                evidence=str(verdict.get("evidence") or ""),
            ))
    return region_items


def summarize_region_supervision(items: list[SemanticItem]) -> dict[str, Any]:
    region_items = build_false_face_region_items(items)
    dataset_counts = Counter(item.dataset for item in region_items)
    scene_counts = Counter(teacher_scene(item.teacher) for item in region_items)
    sample_ids = set((item.dataset, item.stem) for item in region_items)
    examples = []
    for item in region_items[:20]:
        examples.append({
            "dataset": item.dataset,
            "stem": item.stem,
            "sceneType": teacher_scene(item.teacher),
            "hasRealHumanFace": teacher_bool(item.teacher, "hasRealHumanFace"),
            "falseFaceRisk": teacher_float(item.teacher, "falseFaceRisk", 0.0),
            "region": item.region,
            "evidence": item.evidence,
            "path": item.path,
        })
    return {
        "regionCount": len(region_items),
        "sampleCount": len(sample_ids),
        "regionByDataset": dict(sorted(dataset_counts.items())),
        "regionByScene": dict(sorted(scene_counts.items())),
        "maxRegionsPerImage": 3,
        "examples": examples,
    }


def split_items(items: list[SemanticItem], val_frac: float, seed: int):
    rng = np.random.default_rng(seed)
    train: list[SemanticItem] = []
    val: list[SemanticItem] = []
    for dataset in sorted({item.dataset for item in items}):
        group = [item for item in items if item.dataset == dataset]
        indices = np.arange(len(group))
        rng.shuffle(indices)
        n_val = max(1, int(len(group) * val_frac)) if len(group) > 10 else max(0, len(group) // 5)
        val_ids = set(indices[:n_val].tolist())
        for index, item in enumerate(group):
            (val if index in val_ids else train).append(item)
    return train, val


def teacher_float(teacher: dict[str, Any], name: str, default: float = 0.0) -> float:
    try:
        value = teacher.get(name)
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def teacher_bool(teacher: dict[str, Any], name: str, default: bool = False) -> bool:
    value = teacher.get(name)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"true", "yes", "y", "1", "real", "human"}:
        return True
    if text in {"false", "no", "n", "0", "fake", "none", "unknown"}:
        return False
    return default


def teacher_scene(teacher: dict[str, Any]) -> str:
    return str(teacher.get("sceneType") or "other").strip().lower() or "other"


def is_false_face_hard_negative(teacher: dict[str, Any]) -> bool:
    face_validity = teacher_float(teacher, "faceValidityScore", 0.5)
    false_face_risk = teacher_float(teacher, "falseFaceRisk", max(0.0, 1.0 - face_validity))
    has_real_face = teacher_bool(teacher, "hasRealHumanFace")
    return not has_real_face and false_face_risk >= FALSE_FACE_HARD_NEGATIVE_RISK_THRESHOLD


def face_loss_weight(teacher: dict[str, Any]) -> float:
    """Emphasize hard negatives such as wheel/light/poster false-face cases."""
    face_validity = teacher_float(teacher, "faceValidityScore", 0.5)
    false_face_risk = teacher_float(teacher, "falseFaceRisk", max(0.0, 1.0 - face_validity))
    has_real_face = teacher_bool(teacher, "hasRealHumanFace")
    scene = teacher_scene(teacher)
    weight = 1.0 + false_face_risk * 2.0
    if not has_real_face and false_face_risk >= FALSE_FACE_HARD_NEGATIVE_RISK_THRESHOLD:
        weight += FACE_LOSS_FALSE_POSITIVE_PENALTY
    if not has_real_face and scene in TARGET_HIGH_RISK_SCENES and false_face_risk >= 0.35:
        weight *= 1.35
    return float(min(FACE_LOSS_MAX_WEIGHT, max(1.0, weight)))


def sampler_weight(item: SemanticItem) -> float:
    teacher = item.teacher
    false_face_risk = teacher_float(
        teacher,
        "falseFaceRisk",
        max(0.0, 1.0 - teacher_float(teacher, "faceValidityScore", 0.5)),
    )
    weight = 1.0
    if is_false_face_hard_negative(teacher):
        weight *= SAMPLER_HARD_NEGATIVE_WEIGHT
        if teacher_scene(teacher) in TARGET_HIGH_RISK_SCENES:
            weight *= SAMPLER_TARGET_SCENE_MULTIPLIER
    elif teacher_scene(teacher) in TARGET_HIGH_RISK_SCENES and false_face_risk >= 0.35:
        weight *= 1.5
    return float(weight)


def summarize_false_face_training(items: list[SemanticItem]) -> dict[str, Any]:
    total = len(items)
    scene_counts = Counter()
    hard_scene_counts = Counter()
    dataset_counts = Counter()
    hard_dataset_counts = Counter()
    mismatch_count = 0
    mismatch_abs_sum = 0.0
    hard_examples: list[dict[str, Any]] = []
    risk_values: list[float] = []
    derived_values: list[float] = []
    for item in items:
        teacher = item.teacher
        scene = teacher_scene(teacher)
        dataset_counts[item.dataset] += 1
        scene_counts[scene] += 1
        face_validity = teacher_float(teacher, "faceValidityScore", 0.5)
        false_face_risk = teacher_float(teacher, "falseFaceRisk", max(0.0, 1.0 - face_validity))
        derived = max(0.0, min(1.0, 1.0 - face_validity))
        risk_values.append(false_face_risk)
        derived_values.append(derived)
        diff = abs(false_face_risk - derived)
        if diff > 1e-6:
            mismatch_count += 1
            mismatch_abs_sum += diff
        if is_false_face_hard_negative(teacher):
            hard_scene_counts[scene] += 1
            hard_dataset_counts[item.dataset] += 1
            if len(hard_examples) < 16:
                hard_examples.append({
                    "dataset": item.dataset,
                    "stem": item.stem,
                    "sceneType": scene,
                    "faceValidityScore": face_validity,
                    "falseFaceRisk": false_face_risk,
                    "hasRealHumanFace": teacher_bool(teacher, "hasRealHumanFace"),
                    "path": item.path,
                })
    risk_arr = np.array(risk_values, dtype=np.float32)
    derived_arr = np.array(derived_values, dtype=np.float32)
    return {
        "totalItems": total,
        "datasetCounts": dict(sorted(dataset_counts.items())),
        "sceneCounts": dict(sorted(scene_counts.items())),
        "hardNegativeCount": sum(hard_scene_counts.values()),
        "hardNegativeRate": (sum(hard_scene_counts.values()) / total) if total else 0.0,
        "hardNegativeByScene": dict(sorted(hard_scene_counts.items())),
        "hardNegativeByDataset": dict(sorted(hard_dataset_counts.items())),
        "falseFaceRiskDerivedMismatchCount": mismatch_count,
        "falseFaceRiskDerivedMismatchRate": (mismatch_count / total) if total else 0.0,
        "falseFaceRiskDerivedMeanAbsDiff": (mismatch_abs_sum / mismatch_count) if mismatch_count else 0.0,
        "falseFaceRiskMean": float(risk_arr.mean()) if len(risk_arr) else 0.0,
        "derivedFalseFaceRiskMean": float(derived_arr.mean()) if len(derived_arr) else 0.0,
        "hardNegativeExamples": hard_examples,
    }


def write_transmission_diagnosis(
    path: Path,
    *,
    all_summary: dict[str, Any],
    train_summary: dict[str, Any],
    val_summary: dict[str, Any],
    semantic_teacher_path: str,
    semantic_teacher_sha256: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# v12 Student False-Face Transmission Diagnosis",
        "",
        "## Scope",
        "",
        f"- semantic teacher: `{semantic_teacher_path}`",
        f"- semantic teacher sha256: `{semantic_teacher_sha256}`",
        "- teacher prompt/backbone/labels: unchanged",
        "- diagnosis target: why teacher false-face judgement did not transmit into the student layer",
        "",
        "## Key Finding",
        "",
        (
            f"- Teacher `falseFaceRisk` is not equivalent to `1 - faceValidityScore`: "
            f"{all_summary['falseFaceRiskDerivedMismatchCount']} / {all_summary['totalItems']} matched training items differ, "
            f"mean absolute difference = {all_summary['falseFaceRiskDerivedMeanAbsDiff']:.4f}."
        ),
        (
            "- Therefore deriving false-face risk from face validity loses teacher information; "
            "v12 trains and exports an independent `false_face_risk` head."
        ),
        "",
        "## Hard-Negative Coverage",
        "",
        "| Split | Items | Hard negatives | Rate |",
        "|---|---:|---:|---:|",
        f"| all | {all_summary['totalItems']} | {all_summary['hardNegativeCount']} | {all_summary['hardNegativeRate']:.2%} |",
        f"| train | {train_summary['totalItems']} | {train_summary['hardNegativeCount']} | {train_summary['hardNegativeRate']:.2%} |",
        f"| val | {val_summary['totalItems']} | {val_summary['hardNegativeCount']} | {val_summary['hardNegativeRate']:.2%} |",
        "",
        "## Hard Negatives By Scene",
        "",
        "| Scene | All | Train | Val |",
        "|---|---:|---:|---:|",
    ]
    scenes = sorted(
        set(all_summary["hardNegativeByScene"])
        | set(train_summary["hardNegativeByScene"])
        | set(val_summary["hardNegativeByScene"])
    )
    for scene in scenes:
        lines.append(
            f"| `{scene}` | {all_summary['hardNegativeByScene'].get(scene, 0)} | "
            f"{train_summary['hardNegativeByScene'].get(scene, 0)} | "
            f"{val_summary['hardNegativeByScene'].get(scene, 0)} |"
        )
    lines.extend([
        "",
        "## v12 Student Fix",
        "",
        f"- face loss hard-negative max weight: `{FACE_LOSS_MAX_WEIGHT}`",
        f"- false-positive penalty coefficient: `{FACE_LOSS_FALSE_POSITIVE_PENALTY}`",
        f"- false-risk underestimate penalty coefficient: `{FALSE_FACE_RISK_UNDERESTIMATE_PENALTY}`",
        f"- sampler hard-negative multiplier: `{SAMPLER_HARD_NEGATIVE_WEIGHT}`",
        f"- targeted high-risk scenes: `{', '.join(sorted(TARGET_HIGH_RISK_SCENES))}`",
        "",
        "## Example Hard Negatives",
        "",
        "| Dataset | Stem | Scene | Face validity | False-face risk |",
        "|---|---|---|---:|---:|",
    ])
    for row in all_summary["hardNegativeExamples"]:
        lines.append(
            f"| `{row['dataset']}` | `{row['stem']}` | `{row['sceneType']}` | "
            f"{row['faceValidityScore']:.4f} | {row['falseFaceRisk']:.4f} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cosine_loss(pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    pred = nn.functional.normalize(pred, dim=-1)
    target = nn.functional.normalize(target, dim=-1)
    return (1.0 - (pred * target).sum(-1)).mean()


def safe_corr(pred: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    if len(pred) < 3 or float(np.std(pred)) < 1e-8 or float(np.std(truth)) < 1e-8:
        return {"srcc": 0.0, "plcc": 0.0}
    return {
        "srcc": float(spearmanr(pred, truth).statistic),
        "plcc": float(pearsonr(pred, truth)[0]),
    }


@torch.no_grad()
def evaluate(model: SemanticStudent, loader: DataLoader, device: str, aes_norm: Normalizer) -> dict[str, Any]:
    model.eval()
    mean = IMAGENET_MEAN.to(device)
    std = IMAGENET_STD.to(device)
    pred_scalars = {name: [] for name in ["aesthetic", *SCALAR_HEADS]}
    truth_scalars = {name: [] for name in ["aesthetic", *SCALAR_HEADS]}
    pred_false_face_risk = []
    truth_false_face_risk = []
    scene_ok = []
    clip_cos = []
    dino_cos = []
    for px, aes, scene, scalars, false_face_risk, _face_weight, clip, dino in loader:
        px = ((px.to(device) - mean) / std)
        out = model(px)
        pred_scalars["aesthetic"].append(aes_norm.decode(out["aesthetic"].cpu().numpy()))
        truth_scalars["aesthetic"].append(aes.numpy())
        for idx, name in enumerate(SCALAR_HEADS):
            pred_scalars[name].append(torch.sigmoid(out[head_output_name(name)]).cpu().numpy())
            truth_scalars[name].append(scalars[:, idx].numpy())
        pred_false_face_risk.append(torch.sigmoid(out["false_face_risk"]).cpu().numpy())
        truth_false_face_risk.append(false_face_risk.numpy())
        scene_pred = out["scene_logits"].argmax(dim=-1).cpu()
        scene_ok.append((scene_pred == scene).float().numpy())
        clip_cos.append((nn.functional.normalize(out["clip"], dim=-1) * nn.functional.normalize(clip.to(device), dim=-1)).sum(-1).cpu().numpy())
        dino_cos.append((nn.functional.normalize(out["dino"], dim=-1) * nn.functional.normalize(dino.to(device), dim=-1)).sum(-1).cpu().numpy())
    metrics: dict[str, Any] = {
        "sceneAccuracy": float(np.concatenate(scene_ok).mean()),
        "clipCosMean": float(np.concatenate(clip_cos).mean()),
        "dinoCosMean": float(np.concatenate(dino_cos).mean()),
    }
    for name in pred_scalars:
        pred = np.concatenate(pred_scalars[name])
        truth = np.concatenate(truth_scalars[name])
        metrics[f"{name}Corr"] = safe_corr(pred, truth)
    metrics["falseFaceRiskCorr"] = safe_corr(np.concatenate(pred_false_face_risk), np.concatenate(truth_false_face_risk))
    return metrics


def head_output_name(field_name: str) -> str:
    return {
        "semanticKeepScore": "semantic_keep",
        "faceValidityScore": "face_validity",
        "falseFaceRisk": "false_face_risk",
        "compositionScore": "composition",
        "momentScore": "moment",
        "lightingMoodScore": "lighting",
    }[field_name]


def scalar_loss(
    out: dict[str, torch.Tensor],
    scalars: torch.Tensor,
    face_weights: torch.Tensor,
) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
    losses: dict[str, torch.Tensor] = {}
    mse = nn.MSELoss()
    for idx, name in enumerate(SCALAR_HEADS):
        pred = torch.sigmoid(out[head_output_name(name)])
        if name == "faceValidityScore":
            target = scalars[:, idx]
            false_positive = torch.clamp(pred - target, min=0.0)
            asymmetric = 1.0 + false_positive * FACE_LOSS_FALSE_POSITIVE_PENALTY
            losses[name] = (((pred - target) ** 2) * face_weights * asymmetric).mean()
        elif name == "falseFaceRisk":
            target = scalars[:, idx]
            underestimated = torch.clamp(target - pred, min=0.0)
            asymmetric = 1.0 + underestimated * FALSE_FACE_RISK_UNDERESTIMATE_PENALTY
            losses[name] = (((pred - target) ** 2) * face_weights * asymmetric).mean()
        else:
            losses[name] = mse(pred, scalars[:, idx])
    return sum(losses.values()), losses


def region_false_face_loss(out: dict[str, torch.Tensor]) -> torch.Tensor:
    false_face = torch.sigmoid(out["false_face_risk"])
    face_validity = torch.sigmoid(out["face_validity"])
    return (((1.0 - false_face) ** 2) + (face_validity ** 2)).mean()


def next_region_batch(region_iter, region_loader):
    if region_loader is None:
        return None, region_iter
    try:
        return next(region_iter), region_iter
    except StopIteration:
        region_iter = iter(region_loader)
        return next(region_iter), region_iter


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--semantic-teacher", required=True)
    parser.add_argument(
        "--allow-flat-scalar-teacher",
        action="store_true",
        help="Allow flat-scalar ablation teacher records without reasoningTrace/faceRegionVerdicts.",
    )
    parser.add_argument("--quality-teacher-dir", default=QUALITY_TEACHER_DIR)
    parser.add_argument("--camera-previews", default=PREVIEW_DIRS["camera"])
    parser.add_argument("--audit-previews", default=PREVIEW_DIRS["audit3groups"])
    parser.add_argument("--five-mountain-previews", default=f"{LAB}/incoming/five-mountain-previews-384")
    parser.add_argument("--include-five-mountain", action="store_true")
    parser.add_argument(
        "--strict-dataset-match",
        action="store_true",
        help="Do not fall back to a global filename match across datasets. Required for v14 dedupe/holdout isolation.",
    )
    parser.add_argument("--out", required=True)
    parser.add_argument("--backbone", default="convnext_tiny")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--wd", type=float, default=0.05)
    parser.add_argument("--input-size", type=int, default=384)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--max-steps", type=int, default=None)
    parser.add_argument("--allow-missing-dino", action="store_true")
    parser.add_argument("--no-pretrained", action="store_true", help="Disable timm pretrained weights for plumbing smoke tests.")
    parser.add_argument("--w-aesthetic", type=float, default=1.0)
    parser.add_argument("--w-scene", type=float, default=0.7)
    parser.add_argument("--w-semantic", type=float, default=1.2)
    parser.add_argument("--w-face", type=float, default=1.0)
    parser.add_argument("--w-other", type=float, default=0.45)
    parser.add_argument("--w-clip", type=float, default=0.6)
    parser.add_argument("--w-dino", type=float, default=0.8)
    parser.add_argument("--enable-region-supervision", action="store_true")
    parser.add_argument("--w-region-face", type=float, default=1.5)
    parser.add_argument("--region-batch", type=int, default=32)
    parser.add_argument("--region-context-pad", type=float, default=0.16)
    parser.add_argument(
        "--expected-teacher-sha256",
        default=EXPECTED_V12_MERGED_TEACHER_SHA256,
        help="Guardrail for v12 comparable student training. Use empty string to disable only for local smoke tests.",
    )
    parser.add_argument("--use-weighted-sampler", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[env] device={device} gpu={torch.cuda.get_device_name(0) if device == 'cuda' else 'cpu'}", flush=True)

    teacher_sha256 = file_sha256(args.semantic_teacher)
    if args.expected_teacher_sha256 and teacher_sha256 != args.expected_teacher_sha256:
        raise RuntimeError(
            f"semantic teacher sha256 mismatch: expected {args.expected_teacher_sha256}, got {teacher_sha256}"
        )

    items = build_items(args)
    train_items, val_items = split_items(items, 0.1, args.seed)
    all_false_face_summary = summarize_false_face_training(items)
    train_false_face_summary = summarize_false_face_training(train_items)
    val_false_face_summary = summarize_false_face_training(val_items)
    all_region_summary = summarize_region_supervision(items)
    train_region_summary = summarize_region_supervision(train_items)
    val_region_summary = summarize_region_supervision(val_items)
    write_transmission_diagnosis(
        Path(args.out) / "transmission-diagnosis.md",
        all_summary=all_false_face_summary,
        train_summary=train_false_face_summary,
        val_summary=val_false_face_summary,
        semantic_teacher_path=args.semantic_teacher,
        semantic_teacher_sha256=teacher_sha256,
    )
    train_aes = np.array([item.musiq_aes for item in train_items], dtype=np.float32)
    aes_norm = Normalizer(float(train_aes.mean()), float(train_aes.std()))
    print(f"[split] train={len(train_items)} val={len(val_items)} aes_norm={asdict(aes_norm)}", flush=True)

    sampler = None
    shuffle_train = True
    if args.use_weighted_sampler:
        sample_weights = torch.tensor([sampler_weight(item) for item in train_items], dtype=torch.double)
        sampler = WeightedRandomSampler(
            weights=sample_weights,
            num_samples=len(train_items),
            replacement=True,
        )
        shuffle_train = False
        print(
            "[sampler] "
            f"enabled=true min={float(sample_weights.min()):.2f} "
            f"mean={float(sample_weights.mean()):.2f} max={float(sample_weights.max()):.2f}",
            flush=True,
        )

    train_loader = DataLoader(SemanticDataset(train_items, args.input_size, augment=True), batch_size=args.batch,
                              shuffle=shuffle_train, sampler=sampler, num_workers=args.workers, pin_memory=True, drop_last=True)
    val_loader = DataLoader(SemanticDataset(val_items, args.input_size, augment=False), batch_size=args.batch,
                            shuffle=False, num_workers=args.workers, pin_memory=True)
    region_loader = None
    region_iter = None
    train_region_items = build_false_face_region_items(train_items)
    if args.enable_region_supervision:
        if not train_region_items:
            raise RuntimeError("Region supervision was enabled, but no false-face region items were found in the train split")
        region_loader = DataLoader(
            FalseFaceRegionDataset(
                train_region_items,
                args.input_size,
                augment=True,
                context_pad=args.region_context_pad,
            ),
            batch_size=max(1, int(args.region_batch)),
            shuffle=True,
            num_workers=args.workers,
            pin_memory=True,
            drop_last=False,
        )
        region_iter = iter(region_loader)
        print(
            "[region-supervision] "
            f"enabled=true train_samples={train_region_summary['sampleCount']} "
            f"train_regions={train_region_summary['regionCount']} "
            f"batch={args.region_batch} weight={args.w_region_face}",
            flush=True,
        )
    else:
        print(
            "[region-supervision] enabled=false "
            f"available_train_regions={train_region_summary['regionCount']}",
            flush=True,
        )
    clip_dim = int(train_items[0].clip.shape[0])
    dino_dim = int(train_items[0].dino.shape[0])
    if dino_dim != 768 and not args.allow_missing_dino:
        raise RuntimeError(f"DINOv2 embedding must be 768 dims, got {dino_dim}")
    model = SemanticStudent(args.backbone, clip_dim=clip_dim, dino_dim=dino_dim,
                            input_size=args.input_size, pretrained=not args.no_pretrained).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.wd)
    total_steps = args.epochs * max(1, len(train_loader))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=total_steps, pct_start=0.1)
    scaler = torch.amp.GradScaler("cuda", enabled=(device == "cuda"))
    mse = nn.MSELoss()
    ce = nn.CrossEntropyLoss()
    mean = IMAGENET_MEAN.to(device)
    std = IMAGENET_STD.to(device)
    best_score = -1e9
    best_metrics: dict[str, Any] | None = None
    step = 0
    started = time.time()

    for epoch in range(args.epochs):
        model.train()
        losses_seen = []
        for px, aes, scene, scalars, false_face_risk, face_weight, clip, dino in train_loader:
            px = ((px.to(device, non_blocking=True) - mean) / std)
            aes_t = aes_norm.encode(aes).to(device, non_blocking=True)
            scene_t = scene.to(device, non_blocking=True)
            scalars_t = scalars.to(device, non_blocking=True)
            face_weight_t = face_weight.to(device, non_blocking=True)
            false_face_risk_t = false_face_risk.to(device, non_blocking=True)
            clip_t = clip.to(device, non_blocking=True)
            dino_t = dino.to(device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=(device == "cuda")):
                out = model(px)
                scalar_total, scalar_parts = scalar_loss(out, scalars_t, face_weight_t)
                face_loss = scalar_parts["faceValidityScore"]
                false_face_loss = scalar_parts["falseFaceRisk"]
                semantic_loss = scalar_parts["semanticKeepScore"]
                other_scalar_loss = (
                    scalar_parts["compositionScore"] +
                    scalar_parts["momentScore"] +
                    scalar_parts["lightingMoodScore"]
                )
                region_loss = torch.zeros((), device=device)
                if region_loader is not None:
                    region_px, region_iter = next_region_batch(region_iter, region_loader)
                    region_px = ((region_px.to(device, non_blocking=True) - mean) / std)
                    region_out = model(region_px)
                    region_loss = region_false_face_loss(region_out)
                loss = (
                    args.w_aesthetic * mse(out["aesthetic"], aes_t) +
                    args.w_scene * ce(out["scene_logits"], scene_t) +
                    args.w_semantic * semantic_loss +
                    args.w_face * (face_loss + false_face_loss) +
                    args.w_other * other_scalar_loss +
                    args.w_clip * cosine_loss(out["clip"], clip_t) +
                    args.w_dino * cosine_loss(out["dino"], dino_t) +
                    (args.w_region_face * region_loss if region_loader is not None else 0.0)
                )
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            step += 1
            losses_seen.append(float(loss.item()))
            if step % 20 == 0:
                print(f"[train] ep={epoch} step={step} loss={np.mean(losses_seen):.4f} lr={sched.get_last_lr()[0]:.2e}", flush=True)
            if args.max_steps and step >= args.max_steps:
                break
        metrics = evaluate(model, val_loader, device, aes_norm)
        score = (
            metrics["semanticKeepScoreCorr"]["srcc"] +
            0.5 * (metrics["faceValidityScoreCorr"]["srcc"] + metrics["falseFaceRiskCorr"]["srcc"]) +
            metrics["sceneAccuracy"] +
            metrics["dinoCosMean"]
        )
        print(f"[eval] ep={epoch} score={score:.4f} metrics={json.dumps(metrics, ensure_ascii=False)}", flush=True)
        if score > best_score:
            best_score = score
            best_metrics = metrics
            torch.save({
                "schema": "framecull-pro-semantic-student-v2",
                "model": model.state_dict(),
                "backbone": args.backbone,
                "feat_dim": model.feat_dim,
                "clip_dim": clip_dim,
                "dino_dim": dino_dim,
                "scene_labels": SCENE_LABELS,
                "scalar_heads": SCALAR_HEADS,
                "input_size": args.input_size,
                "aesthetic_norm": asdict(aes_norm),
                "metrics": metrics,
                "epoch": epoch,
                "teacher_flat_scalar": args.allow_flat_scalar_teacher,
                "has_independent_false_face_risk_head": True,
                "face_head_supervision": "faceValidityScore and independent falseFaceRisk heads with asymmetric hard-negative emphasis and high-risk scene oversampling",
                "region_face_supervision": (
                    "v14 crop-level false-face negative supervision from faceRegionVerdicts where isRealHumanFace=false"
                    if args.enable_region_supervision
                    else None
                ),
            }, os.path.join(args.out, "student-best.pt"))
            print(f"[save] best score={best_score:.4f} epoch={epoch}", flush=True)
        if args.max_steps and step >= args.max_steps:
            break

    report = {
        "schema": "framecull-pro-semantic-student-training-v1",
        "semanticTeacher": args.semantic_teacher,
        "semanticTeacherSha256": teacher_sha256,
        "expectedSemanticTeacherSha256": args.expected_teacher_sha256 or None,
        "semanticTeacherSha256Verified": (not args.expected_teacher_sha256) or teacher_sha256 == args.expected_teacher_sha256,
        "semanticTeacherRecordCount": count_nonempty_lines(args.semantic_teacher),
        "qualityTeacherDir": args.quality_teacher_dir,
        "backbone": args.backbone,
        "inputSize": args.input_size,
        "batch": args.batch,
        "workers": args.workers,
        "pretrained": not args.no_pretrained,
        "totalItems": len(items),
        "trainItems": len(train_items),
        "valItems": len(val_items),
        "clipDim": clip_dim,
        "dinoDim": dino_dim,
        "sceneLabels": SCENE_LABELS,
        "scalarHeads": SCALAR_HEADS,
        "aestheticNorm": asdict(aes_norm),
        "teacherFlatScalar": args.allow_flat_scalar_teacher,
        "includeFiveMountain": bool(args.include_five_mountain),
        "bestScore": best_score,
        "bestMetrics": best_metrics,
        "labelUse": "No ratings are used in semantic student distillation; ratings are persona/evaluation targets only.",
        "faceHeadSupervision": "faceValidityScore and falseFaceRisk are trained as separate heads with asymmetric hard-negative emphasis; exported falseFaceRisk uses the independent head.",
        "falseFaceV14": {
            "regionSupervisionEnabled": bool(args.enable_region_supervision),
            "regionLoss": "For each false face-like crop, train falseFaceRisk -> 1 and faceValidityScore -> 0 using the shared backbone.",
            "regionLossWeight": args.w_region_face if args.enable_region_supervision else 0.0,
            "regionBatch": args.region_batch if args.enable_region_supervision else 0,
            "regionContextPad": args.region_context_pad,
            "all": all_region_summary,
            "train": train_region_summary,
            "val": val_region_summary,
        },
        "falseFaceV12": {
            "targetHighRiskScenes": sorted(TARGET_HIGH_RISK_SCENES),
            "hardNegativeRiskThreshold": FALSE_FACE_HARD_NEGATIVE_RISK_THRESHOLD,
            "hardNegativeDefinition": "hasRealHumanFace=false and falseFaceRisk >= hardNegativeRiskThreshold",
            "faceLossFalsePositivePenalty": FACE_LOSS_FALSE_POSITIVE_PENALTY,
            "falseFaceRiskUnderestimatePenalty": FALSE_FACE_RISK_UNDERESTIMATE_PENALTY,
            "faceLossMaxWeight": FACE_LOSS_MAX_WEIGHT,
            "weightedSampler": bool(args.use_weighted_sampler),
            "samplerHardNegativeWeight": SAMPLER_HARD_NEGATIVE_WEIGHT,
            "samplerTargetSceneMultiplier": SAMPLER_TARGET_SCENE_MULTIPLIER,
            "all": all_false_face_summary,
            "train": train_false_face_summary,
            "val": val_false_face_summary,
        },
        "qaOnlyFieldsNotTrained": ["storytellingScore", "emptyOrFillerScore", "technicalVisibleIssueScore", "scenicValueScore"],
        "elapsedS": time.time() - started,
    }
    with open(os.path.join(args.out, "training-report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print("==SEMANTIC_STUDENT_DONE==", json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
