#!/usr/bin/env python
"""Build a Phase 3 false-face hard-negative shortlist from training-source candidates.

This script does not create ground truth. It only ranks likely high-value
training-source candidates that still require human confirmation before they
can be patched into the semantic teacher JSONL.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


DEFAULT_SCENES = {
    "product_object",
    "other",
    "landscape",
    "empty_scene",
    "documentary_moment",
}

DEFAULT_SCENE_BOOST = {
    "product_object": 0.35,
    "other": 0.30,
    "landscape": 0.22,
    "empty_scene": 0.18,
    "documentary_moment": 0.14,
    "event": 0.10,
}


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
    index: dict[str, dict[str, Any]] = {}
    for row in iter_jsonl(path):
        key = stem_key(row.get("photoId") or row.get("imagePath") or row.get("studentPreviewPath"))
        if key and key not in index:
            index[key] = row
    return index


def scene_boost(scene: str) -> float:
    return DEFAULT_SCENE_BOOST.get(scene, 0.0)


def compute_rank_score(
    *,
    source: str,
    candidate_scene: str,
    teacher_false_face_risk: float,
    v11_false_face_risk: float,
    v12_false_face_risk: float,
) -> float:
    risk_gap = max(0.0, v11_false_face_risk - v12_false_face_risk)
    source_boost = 0.18 if source == "v11-top" else 0.08
    teacher_low_risk_boost = max(0.0, 0.30 - teacher_false_face_risk)
    return (
        risk_gap * 0.70
        + v11_false_face_risk * 0.20
        + scene_boost(candidate_scene)
        + source_boost
        + teacher_low_risk_boost
    )


def build_reason(
    *,
    source: str,
    candidate_scene: str,
    teacher_false_face_risk: float,
    v11_false_face_risk: float,
    v12_false_face_risk: float,
) -> str:
    parts = [
        f"scene={candidate_scene or 'unknown'}",
        f"source={source or 'unknown'}",
        f"teacher={teacher_false_face_risk:.3f}",
        f"v11={v11_false_face_risk:.3f}",
        f"v12={v12_false_face_risk:.3f}",
    ]
    if v11_false_face_risk >= 0.95 and v12_false_face_risk <= 0.02:
        parts.append("strong_v11_hit_but_v12_near_zero")
    elif v11_false_face_risk >= 0.25 and v12_false_face_risk <= 0.18:
        parts.append("moderate_false_negative_gap")
    if teacher_false_face_risk < 0.5:
        parts.append("would_increase_new_hard_negative_count")
    return "; ".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-union", required=True)
    parser.add_argument("--teacher-jsonl", required=True)
    parser.add_argument("--holdout-ids", required=True)
    parser.add_argument("--output-csv", required=True)
    parser.add_argument("--summary-json")
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--min-v11-risk", type=float, default=0.25)
    parser.add_argument("--max-v12-risk", type=float, default=0.18)
    parser.add_argument("--max-teacher-risk", type=float, default=0.49)
    parser.add_argument("--scene", action="append", default=[])
    args = parser.parse_args()

    candidate_rows = read_csv(Path(args.candidate_union))
    teacher_index = load_teacher_index(Path(args.teacher_jsonl))
    holdout_ids = read_holdout_ids(Path(args.holdout_ids))
    allowed_scenes = {str(item).strip().lower() for item in args.scene if str(item).strip()} or set(DEFAULT_SCENES)

    kept: list[dict[str, Any]] = []
    excluded = Counter()
    kept_by_scene = Counter()
    kept_by_source = Counter()

    for row in candidate_rows:
        photo_id = stem_key(row.get("photo_id") or row.get("photoId"))
        if not photo_id:
            excluded["missing_photo_id"] += 1
            continue
        if photo_id in holdout_ids:
            excluded["holdout_overlap"] += 1
            continue
        if not parse_bool(row.get("exists"), default=False):
            excluded["missing_local_file"] += 1
            continue

        teacher = teacher_index.get(photo_id)
        if teacher is None:
            excluded["missing_teacher_row"] += 1
            continue

        source = str(row.get("source") or "").strip()
        candidate_scene = str(row.get("scene_label") or "").strip().lower()
        if candidate_scene not in allowed_scenes:
            excluded["scene_filtered"] += 1
            continue

        v11_false_face_risk = to_float(row.get("v11_false_face_risk"))
        v12_false_face_risk = to_float(row.get("v12_false_face_risk"))
        teacher_false_face_risk = to_float(teacher.get("falseFaceRisk"))
        teacher_face_validity = to_float(teacher.get("faceValidityScore"))
        teacher_has_real_face = bool(teacher.get("hasRealHumanFace"))

        if v11_false_face_risk < args.min_v11_risk:
            excluded["low_v11_risk"] += 1
            continue
        if v12_false_face_risk > args.max_v12_risk:
            excluded["v12_already_high"] += 1
            continue
        if teacher_false_face_risk > args.max_teacher_risk:
            excluded["teacher_already_hard_negative"] += 1
            continue

        rank_score = compute_rank_score(
            source=source,
            candidate_scene=candidate_scene,
            teacher_false_face_risk=teacher_false_face_risk,
            v11_false_face_risk=v11_false_face_risk,
            v12_false_face_risk=v12_false_face_risk,
        )

        kept.append(
            {
                "photoId": teacher.get("photoId") or photo_id,
                "dataset": teacher.get("dataset", ""),
                "source": source,
                "candidateScene": candidate_scene,
                "teacherSceneType": teacher.get("sceneType", ""),
                "teacherHasRealHumanFace": str(teacher_has_real_face).lower(),
                "teacherFalseFaceRisk": f"{teacher_false_face_risk:.6f}",
                "teacherFaceValidityScore": f"{teacher_face_validity:.6f}",
                "v11FalseFaceRisk": f"{v11_false_face_risk:.6f}",
                "v12FalseFaceRisk": f"{v12_false_face_risk:.6f}",
                "rankScore": f"{rank_score:.6f}",
                "localImagePath": row.get("local_image_path", ""),
                "serverImagePath": row.get("server_image_path", ""),
                "teacherImagePath": teacher.get("imagePath", ""),
                "reasonToReview": build_reason(
                    source=source,
                    candidate_scene=candidate_scene,
                    teacher_false_face_risk=teacher_false_face_risk,
                    v11_false_face_risk=v11_false_face_risk,
                    v12_false_face_risk=v12_false_face_risk,
                ),
                "machineSuggestion": "likely_false_face_hard_negative_needs_human_confirmation",
                "humanConfirmUseForTraining": "",
                "humanConfirmHasRealHumanFace": "",
                "humanConfirmScene": "",
                "humanConfirmIllusionReason": "",
                "patchFalseFaceRisk": "0.90",
                "patchFaceValidityScore": "0.10",
                "notes": "",
            }
        )
        kept_by_scene[candidate_scene] += 1
        kept_by_source[source] += 1

    kept.sort(key=lambda item: (-to_float(item["rankScore"]), -to_float(item["v11FalseFaceRisk"]), item["photoId"]))
    final_rows = kept[: max(0, args.limit)]

    output_path = Path(args.output_csv)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "photoId",
        "dataset",
        "source",
        "candidateScene",
        "teacherSceneType",
        "teacherHasRealHumanFace",
        "teacherFalseFaceRisk",
        "teacherFaceValidityScore",
        "v11FalseFaceRisk",
        "v12FalseFaceRisk",
        "rankScore",
        "localImagePath",
        "serverImagePath",
        "teacherImagePath",
        "reasonToReview",
        "machineSuggestion",
        "humanConfirmUseForTraining",
        "humanConfirmHasRealHumanFace",
        "humanConfirmScene",
        "humanConfirmIllusionReason",
        "patchFalseFaceRisk",
        "patchFaceValidityScore",
        "notes",
    ]
    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in final_rows:
            writer.writerow(row)

    summary = {
        "schemaVersion": "framecull-false-face-v13-phase3-shortlist-v1",
        "candidateUnion": str(Path(args.candidate_union)),
        "teacherJsonl": str(Path(args.teacher_jsonl)),
        "holdoutIdsPath": str(Path(args.holdout_ids)),
        "limit": args.limit,
        "minV11Risk": args.min_v11_risk,
        "maxV12Risk": args.max_v12_risk,
        "maxTeacherRisk": args.max_teacher_risk,
        "allowedScenes": sorted(allowed_scenes),
        "candidateRows": len(candidate_rows),
        "teacherRowsIndexed": len(teacher_index),
        "holdoutCount": len(holdout_ids),
        "keptBeforeLimit": len(kept),
        "keptAfterLimit": len(final_rows),
        "excluded": dict(sorted(excluded.items())),
        "keptByScene": dict(sorted(kept_by_scene.items())),
        "keptBySource": dict(sorted(kept_by_source.items())),
        "topPhotoIds": [row["photoId"] for row in final_rows[:20]],
        "note": "Rows in this shortlist are NOT ground truth. They still require human confirmation before patching the teacher JSONL.",
    }

    if args.summary_json:
        summary_path = Path(args.summary_json)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
