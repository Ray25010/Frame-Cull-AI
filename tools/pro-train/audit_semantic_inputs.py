#!/usr/bin/env python
"""Audit Semantic Teacher Lab inputs and build image manifests.

Phase 0 output feeds both the high-resolution VLM teacher path and the 384px
student path. By default, records without a high-resolution teacher image are
excluded from teacher manifests instead of silently falling back to 384px
previews.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image


IMAGE_EXTENSIONS = [".arw", ".nef", ".cr2", ".cr3", ".raf", ".dng", ".jpg", ".jpeg", ".png", ".heic"]
DEFAULT_TEACHER_MIN_LONG_EDGE = 768


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def stem(path: Path | str) -> str:
    return Path(str(path)).stem


def collect_preview_paths(preview_dir: Path) -> list[Path]:
    if not preview_dir.exists():
        return []
    return sorted(p for p in preview_dir.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png"})


def same_path(a: Path | str | None, b: Path | str | None) -> bool:
    if not a or not b:
        return False
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return str(Path(a)) == str(Path(b))


def image_long_edge(path: Path | str | None) -> int:
    if not path:
        return 0
    try:
        with Image.open(path) as image:
            width, height = image.size
        return max(int(width), int(height))
    except Exception:
        return 0


def is_preview_teacher_fallback(
    teacher_path: Path | str | None,
    preview_path: Path | str | None,
    *,
    min_long_edge: int,
) -> tuple[bool, int]:
    if not teacher_path:
        return False, 0
    long_edge = image_long_edge(teacher_path)
    if not same_path(teacher_path, preview_path):
        return False, long_edge
    # Shared teacher/student path is allowed when the file itself is already
    # high-resolution enough for VLM annotation. Only small same-path inputs
    # count as preview fallback.
    return long_edge < int(min_long_edge), long_edge


def index_original_dirs(dirs: list[Path]) -> dict[str, str]:
    index: dict[str, str] = {}
    for root in dirs:
        if not root or not root.exists():
            continue
        for current, _, files in os.walk(root):
            for name in files:
                suffix = Path(name).suffix.lower()
                if suffix not in IMAGE_EXTENSIONS:
                    continue
                key = Path(name).stem
                index.setdefault(key, str(Path(current) / name))
    return index


def parse_label_value(value: Any) -> int:
    if isinstance(value, dict):
        value = value.get("rating", value.get("label", 0))
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = 0
    return max(0, min(5, number))


def labels_from_manifest(path: Path) -> tuple[dict[str, int], dict[str, str]]:
    raw = read_json(path)
    source_paths = {}
    labels = {}
    if "records" in raw:
        for key, value in raw.get("records", {}).items():
            labels[key] = parse_label_value(value)
            if isinstance(value, dict) and value.get("sourcePath"):
                source_paths[key] = str(value["sourcePath"])
    else:
        for key, value in raw.get("labels", {}).items():
            labels[key] = parse_label_value(value)
        for key, value in raw.get("sourceNames", {}).items():
            source_paths[key] = str(value)
    return labels, source_paths


def build_dataset_records(
    *,
    dataset: str,
    preview_dir: Path,
    labels_path: Path,
    positive_threshold: int,
    original_dirs: list[Path],
    allow_preview_teacher_input: bool,
    teacher_min_long_edge: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    labels, source_paths = labels_from_manifest(labels_path)
    original_index = index_original_dirs(original_dirs)
    records = []
    missing_teacher = []
    preview_fallback = []
    preview_paths = collect_preview_paths(preview_dir)

    for preview_path in preview_paths:
        photo_id = preview_path.stem
        rating = labels.get(photo_id, 0)
        teacher_path = None
        if photo_id in source_paths and Path(source_paths[photo_id]).exists():
            teacher_path = source_paths[photo_id]
        elif photo_id in original_index:
            teacher_path = original_index[photo_id]
        elif allow_preview_teacher_input:
            teacher_path = str(preview_path)
        else:
            missing_teacher.append(photo_id)
        is_preview_fallback, teacher_long_edge = is_preview_teacher_fallback(
            teacher_path,
            preview_path,
            min_long_edge=teacher_min_long_edge,
        )
        if is_preview_fallback and not allow_preview_teacher_input:
            preview_fallback.append(photo_id)
            missing_teacher.append(photo_id)
        records.append({
            "photoId": photo_id,
            "dataset": dataset,
            "studentPreviewPath": str(preview_path),
            "teacherImagePath": teacher_path,
            "teacherImageIsPreviewFallback": is_preview_fallback,
            "teacherImageLongEdge": teacher_long_edge,
            "teacherMinLongEdge": teacher_min_long_edge,
            "rating": rating,
            "positiveThreshold": positive_threshold,
            "positive": rating >= positive_threshold,
            "negative": rating < positive_threshold,
        })

    rating_counts = Counter(str(record["rating"]) for record in records)
    teacher_ready_count = sum(
        1
        for record in records
        if record["teacherImagePath"] and (allow_preview_teacher_input or not record["teacherImageIsPreviewFallback"])
    )
    summary = {
        "dataset": dataset,
        "previewDir": str(preview_dir),
        "labelsPath": str(labels_path),
        "originalDirs": [str(p) for p in original_dirs],
        "positiveThreshold": positive_threshold,
        "previewCount": len(preview_paths),
        "labelCount": len(labels),
        "records": len(records),
        "positive": sum(1 for record in records if record["positive"]),
        "negative": sum(1 for record in records if record["negative"]),
        "ratingCounts": dict(sorted(rating_counts.items())),
        "teacherMinLongEdge": teacher_min_long_edge,
        "teacherImageCount": teacher_ready_count,
        "previewFallbackTeacherImageCount": len(preview_fallback),
        "previewFallbackTeacherImageExamples": preview_fallback[:30],
        "missingTeacherImageCount": len(missing_teacher),
        "missingTeacherImageExamples": missing_teacher[:30],
    }
    return records, summary


def write_markdown(path: Path, payload: dict[str, Any]) -> None:
    lines = [
        "# FrameCull Semantic Teacher Input Audit",
        "",
        f"- Created at: `{payload['createdAt']}`",
        f"- Total records: `{payload['totalRecords']}`",
        f"- Teacher-ready records: `{payload['teacherReadyRecords']}`",
        f"- Preview fallback allowed: `{payload['allowPreviewTeacherInput']}`",
        "",
        "## Datasets",
        "",
        "| Dataset | Records | Positive k | Positives | Negatives | Teacher-ready | Preview fallback | Missing teacher |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in payload["datasets"]:
        lines.append(
            f"| `{item['dataset']}` | {item['records']} | {item['positiveThreshold']} | "
            f"{item['positive']} | {item['negative']} | {item['teacherImageCount']} | "
            f"{item['previewFallbackTeacherImageCount']} | {item['missingTeacherImageCount']} |"
        )
    lines += [
        "",
        "## Gate",
        "",
        "- PASS only when every intended teacher record has a teacher image whose long edge meets the minimum requirement.",
        "- Same-path teacher/student inputs are allowed when that shared image is already high-resolution enough for teacher annotation.",
        f"- Emergency preview fallback means long edge below `{payload['teacherMinLongEdge']}` and must not be used for full teacher annotation.",
        "",
        f"Gate status: **{payload['gateStatus']}**",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gdrive-previews", type=Path, required=True)
    parser.add_argument("--gdrive-labels", type=Path, required=True)
    parser.add_argument("--gdrive-original-dirs", default="")
    parser.add_argument("--camera-previews", type=Path, required=True)
    parser.add_argument("--camera-labels", type=Path, required=True)
    parser.add_argument("--camera-original-dirs", default="")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--allow-preview-teacher-input", action="store_true")
    parser.add_argument("--teacher-min-long-edge", type=int, default=DEFAULT_TEACHER_MIN_LONG_EDGE)
    args = parser.parse_args()

    gdrive_originals = [Path(x) for x in args.gdrive_original_dirs.split(";") if x.strip()]
    camera_originals = [Path(x) for x in args.camera_original_dirs.split(";") if x.strip()]
    all_records: list[dict[str, Any]] = []
    summaries = []

    for kwargs in [
        {
            "dataset": "audit3groups",
            "preview_dir": args.gdrive_previews,
            "labels_path": args.gdrive_labels,
            "positive_threshold": 3,
            "original_dirs": gdrive_originals,
        },
        {
            "dataset": "camera",
            "preview_dir": args.camera_previews,
            "labels_path": args.camera_labels,
            "positive_threshold": 1,
            "original_dirs": camera_originals,
        },
    ]:
        records, summary = build_dataset_records(
            **kwargs,
            allow_preview_teacher_input=args.allow_preview_teacher_input,
            teacher_min_long_edge=args.teacher_min_long_edge,
        )
        all_records.extend(records)
        summaries.append(summary)

    teacher_records = [
        record for record in all_records
        if record["teacherImagePath"] and (args.allow_preview_teacher_input or not record["teacherImageIsPreviewFallback"])
    ]
    grouped = defaultdict(list)
    for record in teacher_records:
        grouped[record["dataset"]].append(record)
    smoke = []
    for dataset, group in sorted(grouped.items()):
        positives = [r for r in group if r["positive"]]
        negatives = [r for r in group if r["negative"]]
        smoke.extend(positives[:20])
        smoke.extend(negatives[:20])
        smoke.extend(group[:10])
    smoke = list({record["photoId"] + record["dataset"]: record for record in smoke}.values())[:80]

    payload = {
        "schemaVersion": "framecull-semantic-input-audit-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "allowPreviewTeacherInput": args.allow_preview_teacher_input,
        "teacherMinLongEdge": args.teacher_min_long_edge,
        "datasets": summaries,
        "totalRecords": len(all_records),
        "teacherReadyRecords": len(teacher_records),
        "gateStatus": "PASS" if len(teacher_records) == len(all_records) and not args.allow_preview_teacher_input else "REVIEW",
    }

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "data-audit.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.out / "all-images.json").write_text(json.dumps(teacher_records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.out / "smoke-list.json").write_text(json.dumps(smoke, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out / "data-audit.md", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
