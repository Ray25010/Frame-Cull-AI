#!/usr/bin/env python
"""Merge manually reviewed independent false-face candidates into the holdout.

This script only accepts human-confirmed rows. It keeps the existing holdout as
the source of truth, appends new confirmed rows, removes duplicate photoIds, and
writes a focused coverage report so the v13 task can be audited scene by scene.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


REQUIRED_SCENES = {"landscape", "product_object", "empty_scene", "event", "food"}
ROLE_FALSE_FACE = "false_face_positive"
ROLE_REAL_FACE = "real_face_control"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = [
        "photoId",
        "absolutePath",
        "sampleRole",
        "hasRealHumanFace",
        "scene",
        "illusionReason",
        "manualLabel",
        "notes",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fieldnames})


def stem_key(value: Any) -> str:
    text = str(value or "").strip().strip('"').strip("'")
    if not text:
        return ""
    key = Path(text).stem.lower()
    while True:
        inner = Path(key).stem.lower()
        if inner == key:
            return key
        key = inner


def normalized_bool(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return "true"
    if text in {"false", "0", "no", "n"}:
        return "false"
    return ""


def normalize_existing(row: dict[str, str]) -> dict[str, str]:
    return {
        "photoId": str(row.get("photoId") or "").strip(),
        "absolutePath": str(row.get("absolutePath") or "").strip(),
        "sampleRole": str(row.get("sampleRole") or "").strip(),
        "hasRealHumanFace": normalized_bool(row.get("hasRealHumanFace")),
        "scene": str(row.get("scene") or "").strip(),
        "illusionReason": str(row.get("illusionReason") or "").strip(),
        "manualLabel": str(row.get("manualLabel") or "").strip() or "human-confirmed",
        "notes": str(row.get("notes") or "").strip(),
    }


def normalize_candidate(row: dict[str, str]) -> dict[str, str] | None:
    manual = str(row.get("manualLabel") or "").strip().lower()
    if manual != "human-confirmed":
        return None
    photo_id = str(row.get("photoId") or "").strip()
    role = str(row.get("sampleRole") or "").strip()
    has_real_face = normalized_bool(row.get("hasRealHumanFace"))
    scene = str(row.get("scene") or "").strip()
    reason = str(row.get("illusionReason") or "").strip()
    if not photo_id or not role or not has_real_face or not scene or not reason:
        return None
    return {
        "photoId": photo_id,
        "absolutePath": str(row.get("absolutePath") or "").strip(),
        "sampleRole": role,
        "hasRealHumanFace": has_real_face,
        "scene": scene,
        "illusionReason": reason,
        "manualLabel": "human-confirmed",
        "notes": str(row.get("notes") or "").strip() or "merged from independent candidate review",
    }


def summarize(rows: list[dict[str, str]]) -> dict[str, Any]:
    role_counts = Counter(row.get("sampleRole", "") for row in rows)
    false_rows = [row for row in rows if row.get("sampleRole") == ROLE_FALSE_FACE]
    control_rows = [row for row in rows if row.get("sampleRole") == ROLE_REAL_FACE]
    false_scene_counts = Counter(row.get("scene", "") for row in false_rows)
    missing = sorted(scene for scene in REQUIRED_SCENES if false_scene_counts.get(scene, 0) <= 0)
    return {
        "rows": len(rows),
        "roleCounts": dict(sorted(role_counts.items())),
        "falseFacePositiveCount": len(false_rows),
        "realFaceControlCount": len(control_rows),
        "falseFaceSceneCounts": dict(sorted(false_scene_counts.items())),
        "requiredFalseFaceScenes": sorted(REQUIRED_SCENES),
        "missingRequiredFalseFaceScenes": missing,
        "sampleCountOk": 30 <= len(false_rows) <= 60 and 20 <= len(control_rows) <= 30,
        "sceneCoverageOk": not missing,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--reviewed", action="append", default=[])
    parser.add_argument("--output", required=True)
    parser.add_argument("--summary-json", required=True)
    parser.add_argument("--include-sample-role", action="append", default=[])
    parser.add_argument("--max-false-face-positive", type=int, default=0)
    parser.add_argument("--max-real-face-control", type=int, default=0)
    parser.add_argument("--prioritize-missing-scenes", action="store_true")
    args = parser.parse_args()

    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    duplicates: list[str] = []
    role_caps = {
        ROLE_FALSE_FACE: args.max_false_face_positive if args.max_false_face_positive > 0 else None,
        ROLE_REAL_FACE: args.max_real_face_control if args.max_real_face_control > 0 else None,
    }
    allowed_roles = {str(role).strip() for role in args.include_sample_role if str(role).strip()}

    for row in read_csv(Path(args.base)):
        item = normalize_existing(row)
        key = stem_key(item["photoId"])
        if not key:
            continue
        if key in seen:
            duplicates.append(item["photoId"])
            continue
        seen.add(key)
        merged.append(item)

    def current_role_count(role: str) -> int:
        return sum(1 for row in merged if row.get("sampleRole") == role)

    added = 0
    skipped_reviewed = 0
    skipped_role_filter = 0
    skipped_role_cap = 0
    candidate_items: list[dict[str, str]] = []
    for reviewed_path in args.reviewed:
        for row in read_csv(Path(reviewed_path)):
            item = normalize_candidate(row)
            if item is None:
                skipped_reviewed += 1
                continue
            if allowed_roles and item["sampleRole"] not in allowed_roles:
                skipped_role_filter += 1
                continue
            candidate_items.append(item)

    if args.prioritize_missing_scenes:
        base_summary = summarize(merged)
        missing_scenes = set(base_summary["missingRequiredFalseFaceScenes"])

        def sort_key(item: dict[str, str]) -> tuple[int, int]:
            role = item.get("sampleRole", "")
            scene = item.get("scene", "")
            role_rank = 0 if role == ROLE_FALSE_FACE else 1
            missing_rank = 0 if role == ROLE_FALSE_FACE and scene in missing_scenes else 1
            return (missing_rank, role_rank)

        candidate_items = sorted(candidate_items, key=sort_key)

    for item in candidate_items:
        key = stem_key(item["photoId"])
        if key in seen:
            duplicates.append(item["photoId"])
            continue
        cap = role_caps.get(item["sampleRole"])
        if cap is not None and current_role_count(item["sampleRole"]) >= cap:
            skipped_role_cap += 1
            continue
        seen.add(key)
        merged.append(item)
        added += 1

    output_path = Path(args.output)
    write_csv(output_path, merged)
    summary = summarize(merged)
    payload = {
        "schemaVersion": "framecull-false-face-independent-review-merge-v1",
        "base": str(Path(args.base)),
        "reviewed": [str(Path(path)) for path in args.reviewed],
        "output": str(output_path),
        "addedRows": added,
        "skippedReviewedRows": skipped_reviewed,
        "skippedRoleFilterRows": skipped_role_filter,
        "skippedRoleCapRows": skipped_role_cap,
        "allowedRoles": sorted(allowed_roles),
        "roleCaps": role_caps,
        "prioritizeMissingScenes": bool(args.prioritize_missing_scenes),
        "duplicatePhotoIds": duplicates[:100],
        **summary,
    }
    summary_path = Path(args.summary_json)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
