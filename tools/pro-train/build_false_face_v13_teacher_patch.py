#!/usr/bin/env python
"""Build a teacher patch JSONL from human-confirmed Phase 3 false-face rows.

This script is intentionally conservative:
- it refuses to patch holdout photoIds
- it only patches rows explicitly marked for training use
- it validates every patched row against the grounded semantic teacher schema
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from semantic_teacher_schema import normalize_record, validate_record


def stem_key(value: Any) -> str:
    text = str(value or "").strip().strip('"').strip("'")
    if not text:
        return ""
    key = Path(text).stem.lower()
    while True:
        inner = Path(key).stem.lower()
        if inner == key:
            break
        key = inner
    return key


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return True
    if text in {"false", "0", "no", "n"}:
        return False
    return default


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_holdout_ids(path: Path) -> set[str]:
    holdout_ids: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            key = stem_key(line)
            if key:
                holdout_ids.add(key)
    return holdout_ids


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            yield json.loads(text)


def load_teacher_index(path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in iter_jsonl(path):
        key = stem_key(row.get("photoId") or row.get("imagePath") or row.get("studentPreviewPath"))
        if key and key not in out:
            out[key] = row
    return out


def pick_region_from_record(record: dict[str, Any]) -> list[float]:
    for field in ("faceRegionVerdicts", "reasoningTrace", "regions"):
        for item in record.get(field, []) or []:
            if not isinstance(item, dict):
                continue
            region = item.get("region") if field != "regions" else item.get("box")
            if isinstance(region, list) and len(region) == 4:
                return region
    return [0.0, 0.0, 1.0, 1.0]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-teacher", required=True)
    parser.add_argument("--confirmed-shortlist", required=True)
    parser.add_argument("--holdout-ids", required=True)
    parser.add_argument("--output-jsonl", required=True)
    parser.add_argument("--summary-json")
    args = parser.parse_args()

    baseline_path = Path(args.baseline_teacher)
    confirmed_path = Path(args.confirmed_shortlist)
    holdout_ids = read_holdout_ids(Path(args.holdout_ids))
    baseline_index = load_teacher_index(baseline_path)
    confirmed_rows = read_csv(confirmed_path)

    patched_rows: list[dict[str, Any]] = []
    skipped = {
        "blank_use_flag": 0,
        "holdout_overlap": 0,
        "confirmed_real_face": 0,
        "missing_teacher_row": 0,
        "invalid_patch": 0,
    }

    for row in confirmed_rows:
        photo_id = stem_key(row.get("photoId") or row.get("photo_id"))
        if not photo_id:
            skipped["missing_teacher_row"] += 1
            continue
        if not parse_bool(row.get("humanConfirmUseForTraining"), default=False):
            skipped["blank_use_flag"] += 1
            continue
        if photo_id in holdout_ids:
            skipped["holdout_overlap"] += 1
            continue
        if parse_bool(row.get("humanConfirmHasRealHumanFace"), default=False):
            skipped["confirmed_real_face"] += 1
            continue

        base = baseline_index.get(photo_id)
        if base is None:
            skipped["missing_teacher_row"] += 1
            continue

        false_face_risk = max(0.60, min(1.0, to_float(row.get("patchFalseFaceRisk"), 0.90)))
        face_validity = max(0.0, min(0.40, to_float(row.get("patchFaceValidityScore"), 0.10)))
        illusion_reason = str(
            row.get("humanConfirmIllusionReason")
            or row.get("notes")
            or "human-confirmed phase3 false-face hard negative; visually face-like non-human/object region"
        ).strip()
        scene_value = str(
            row.get("humanConfirmScene")
            or row.get("candidateScene")
            or row.get("teacherSceneType")
            or base.get("sceneType")
            or "other"
        ).strip()

        patched = dict(base)
        patched["sceneType"] = scene_value
        patched["hasRealHumanFace"] = False
        patched["faceValidityScore"] = face_validity
        patched["falseFaceRisk"] = false_face_risk
        patched["faceRegionVerdicts"] = [
            {
                "region": pick_region_from_record(base),
                "isRealHumanFace": False,
                "evidence": illusion_reason,
                "confidence": max(0.80, false_face_risk),
            }
        ]
        uncertain = [str(item) for item in (patched.get("uncertain") or []) if str(item).strip()]
        uncertain.append("phase3_false_face_hard_negative_patch")
        patched["uncertain"] = uncertain

        normalized = normalize_record(patched, flat_scalar=False)
        errors = validate_record(normalized, allow_flat_scalar=False)
        if errors:
            skipped["invalid_patch"] += 1
            continue
        patched_rows.append(normalized)

    output_path = Path(args.output_jsonl)
    write_jsonl(output_path, patched_rows)

    summary = {
        "schemaVersion": "framecull-false-face-v13-teacher-patch-v1",
        "baselineTeacher": str(baseline_path),
        "confirmedShortlist": str(confirmed_path),
        "holdoutIdsPath": str(Path(args.holdout_ids)),
        "baselineTeacherRowCount": len(baseline_index),
        "confirmedRows": len(confirmed_rows),
        "patchedRows": len(patched_rows),
        "patchedPhotoIds": [row.get("photoId") for row in patched_rows[:50]],
        "skipped": skipped,
        "note": "Only rows explicitly confirmed for training use and confirmed as non-human-face were patched.",
    }

    if args.summary_json:
        summary_path = Path(args.summary_json)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
