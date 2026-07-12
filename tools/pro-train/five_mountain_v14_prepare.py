#!/usr/bin/env python
"""Prepare the Five Mountain v14 semantic-student training set.

This script is intentionally data-only. It audits the Five Mountain teacher
records, verifies the v13 independent holdout is excluded, deduplicates against
the existing 6475-record teacher set, and writes the merged v14 teacher JSONL.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


EXPECTED_BASE_TEACHER_SHA256 = "04f5527f8bc6922a743d20cefd5b537c6cf87882d119d20581b2b81985c62059"
HARD_NEGATIVE_RISK_THRESHOLD = 0.5


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                yield line_no, json.loads(text)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"{path}:{line_no}: invalid JSON: {exc}") from exc


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [record for _line_no, record in iter_jsonl(path)]


def stem_key(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip().strip('"').strip("'")
    if not text:
        return ""
    stem = Path(text).stem.lower()
    while True:
        inner = Path(stem).stem.lower()
        if inner == stem:
            break
        stem = inner
    return stem


def record_aliases(record: dict[str, Any]) -> set[str]:
    aliases: set[str] = set()
    for field in (
        "photoId",
        "imagePath",
        "teacherImagePath",
        "studentPreviewPath",
        "sourcePath",
        "importPath",
        "absolutePath",
        "fileName",
    ):
        key = stem_key(record.get(field))
        if key:
            aliases.add(key)
    return aliases


def bool_value(value: Any, default: bool = False) -> bool:
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


def float_value(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def false_regions(record: dict[str, Any]) -> list[dict[str, Any]]:
    regions = []
    for verdict in record.get("faceRegionVerdicts") or []:
        if not isinstance(verdict, dict):
            continue
        if bool_value(verdict.get("isRealHumanFace"), default=True):
            continue
        region = verdict.get("region")
        if isinstance(region, list) and len(region) == 4:
            regions.append(verdict)
    return regions


def is_hard_negative(record: dict[str, Any]) -> bool:
    has_real = bool_value(record.get("hasRealHumanFace"), default=False)
    risk = float_value(record.get("falseFaceRisk"), default=max(0.0, 1.0 - float_value(record.get("faceValidityScore"), 0.5)))
    return (not has_real) and risk >= HARD_NEGATIVE_RISK_THRESHOLD


def summarize_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    scene = Counter(str(row.get("sceneType") or "unknown") for row in records)
    face_counts = Counter()
    hard_by_scene = Counter()
    region_by_scene = Counter()
    region_records = 0
    region_count = 0
    examples = []
    risk_values = []
    for row in records:
        has_real = bool_value(row.get("hasRealHumanFace"), default=False)
        face_counts["true" if has_real else "false"] += 1
        risk = float_value(row.get("falseFaceRisk"), default=max(0.0, 1.0 - float_value(row.get("faceValidityScore"), 0.5)))
        risk_values.append(risk)
        scene_name = str(row.get("sceneType") or "unknown")
        if is_hard_negative(row):
            hard_by_scene[scene_name] += 1
        regions = false_regions(row)
        if regions:
            region_records += 1
            region_count += len(regions)
            region_by_scene[scene_name] += len(regions)
            if len(examples) < 20:
                examples.append({
                    "photoId": row.get("photoId"),
                    "dataset": row.get("dataset"),
                    "sceneType": scene_name,
                    "hasRealHumanFace": has_real,
                    "falseFaceRisk": risk,
                    "falseRegionCount": len(regions),
                    "regions": [
                        {
                            "region": verdict.get("region"),
                            "confidence": verdict.get("confidence"),
                            "evidence": verdict.get("evidence"),
                        }
                        for verdict in regions[:3]
                    ],
                })
    return {
        "recordCount": len(records),
        "sceneDistribution": dict(sorted(scene.items())),
        "hasRealHumanFaceCounts": dict(sorted(face_counts.items())),
        "hardNegativeDefinition": f"hasRealHumanFace=false and falseFaceRisk >= {HARD_NEGATIVE_RISK_THRESHOLD}",
        "hardNegativeCount": sum(hard_by_scene.values()),
        "hardNegativeByScene": dict(sorted(hard_by_scene.items())),
        "faceLikeFalseRegionSampleCount": region_records,
        "faceLikeFalseRegionCount": region_count,
        "faceLikeFalseRegionByScene": dict(sorted(region_by_scene.items())),
        "falseFaceRiskMean": (sum(risk_values) / len(risk_values)) if risk_values else 0.0,
        "falseRegionExamples": examples,
    }


def read_holdout_aliases(path: Path) -> dict[str, dict[str, Any]]:
    aliases: dict[str, dict[str, Any]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            row_aliases = set()
            for field in ("photoId", "absolutePath", "imagePath", "fileName"):
                key = stem_key(row.get(field))
                if key:
                    row_aliases.add(key)
            for key in row_aliases:
                aliases.setdefault(key, row)
    return aliases


def find_intersections(
    left_records: list[dict[str, Any]],
    right_aliases: dict[str, Any],
    *,
    max_examples: int = 30,
) -> tuple[int, list[dict[str, Any]]]:
    count = 0
    examples: list[dict[str, Any]] = []
    seen_records: set[int] = set()
    for index, record in enumerate(left_records):
        matches = sorted(record_aliases(record) & set(right_aliases))
        if not matches or index in seen_records:
            continue
        count += 1
        seen_records.add(index)
        if len(examples) < max_examples:
            examples.append({
                "photoId": record.get("photoId"),
                "dataset": record.get("dataset"),
                "matchedAliases": matches[:8],
                "matchedAgainst": right_aliases[matches[0]],
            })
    return count, examples


def build_alias_index(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    collisions: set[str] = set()
    for record in records:
        for alias in record_aliases(record):
            existing = index.get(alias)
            if existing is not None and existing.get("photoId") != record.get("photoId"):
                collisions.add(alias)
            else:
                index[alias] = record
    for alias in collisions:
        index.pop(alias, None)
    return index


def duplicate_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    by_alias: defaultdict[str, list[str]] = defaultdict(list)
    for record in records:
        photo_id = str(record.get("photoId") or "")
        for alias in record_aliases(record):
            by_alias[alias].append(photo_id)
    duplicates = {
        alias: ids
        for alias, ids in by_alias.items()
        if len(set(ids)) > 1
    }
    return {
        "duplicateAliasCount": len(duplicates),
        "examples": [
            {"alias": alias, "photoIds": sorted(set(ids))[:8]}
            for alias, ids in list(sorted(duplicates.items()))[:20]
        ],
    }


def split_distribution(records: list[dict[str, Any]], val_frac: float, seed: int) -> dict[str, Any]:
    import numpy as np

    train: list[dict[str, Any]] = []
    val: list[dict[str, Any]] = []
    for dataset in sorted({str(row.get("dataset") or "unknown") for row in records}):
        group = [row for row in records if str(row.get("dataset") or "unknown") == dataset]
        indices = np.arange(len(group))
        rng = np.random.default_rng(seed)
        rng.shuffle(indices)
        n_val = max(1, int(len(group) * val_frac)) if len(group) > 10 else max(0, len(group) // 5)
        val_ids = set(indices[:n_val].tolist())
        for index, row in enumerate(group):
            (val if index in val_ids else train).append(row)
    return {
        "seed": seed,
        "valFrac": val_frac,
        "train": summarize_records(train),
        "val": summarize_records(val),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-teacher", required=True)
    parser.add_argument("--five-teacher", required=True)
    parser.add_argument("--holdout-csv", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--merged-teacher", required=True)
    parser.add_argument("--expected-base-sha256", default=EXPECTED_BASE_TEACHER_SHA256)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--val-frac", type=float, default=0.1)
    parser.add_argument(
        "--strict-raw-five-holdout-zero",
        action="store_true",
        help="Abort if raw Five Mountain records overlap the independent holdout. By default overlaps are reported and excluded.",
    )
    args = parser.parse_args()

    base_path = Path(args.base_teacher)
    five_path = Path(args.five_teacher)
    holdout_path = Path(args.holdout_csv)
    out_dir = Path(args.out_dir)
    merged_path = Path(args.merged_teacher)
    out_dir.mkdir(parents=True, exist_ok=True)
    merged_path.parent.mkdir(parents=True, exist_ok=True)

    base_sha = sha256(base_path)
    if args.expected_base_sha256 and base_sha != args.expected_base_sha256:
        raise RuntimeError(f"base teacher SHA mismatch: expected {args.expected_base_sha256}, got {base_sha}")

    base_records = read_jsonl(base_path)
    five_records = read_jsonl(five_path)
    holdout_aliases = read_holdout_aliases(holdout_path)
    base_alias_index = build_alias_index(base_records)

    five_holdout_count, five_holdout_examples = find_intersections(five_records, holdout_aliases)
    five_base_count, five_base_examples = find_intersections(five_records, base_alias_index)
    base_holdout_count, base_holdout_examples = find_intersections(base_records, holdout_aliases)

    five_summary = summarize_records(five_records)
    decision_note = (
        "Five Mountain whole-image hard negatives are sparse; v14 false-face learning should rely mainly on region/crop supervision."
        if five_summary["hardNegativeCount"] < 10
        else "Five Mountain has enough whole-image hard negatives to assist, but v14 still uses region/crop supervision as the core increment."
    )

    inventory = {
        "schemaVersion": "framecull-five-mountain-v14-inventory-v1",
        "baseTeacher": str(base_path),
        "baseTeacherSha256": base_sha,
        "baseTeacherSha256Expected": args.expected_base_sha256,
        "baseTeacherSha256Verified": (not args.expected_base_sha256) or base_sha == args.expected_base_sha256,
        "baseTeacherRecordCount": len(base_records),
        "fiveTeacher": str(five_path),
        "fiveTeacherSha256": sha256(five_path),
        "fiveMountain": five_summary,
        "holdoutCsv": str(holdout_path),
        "holdoutAliasCount": len(holdout_aliases),
        "intersections": {
            "fiveMountainHoldoutCount": five_holdout_count,
            "fiveMountainHoldoutExamples": five_holdout_examples,
            "fiveMountainExisting6475Count": five_base_count,
            "fiveMountainExisting6475Examples": five_base_examples,
            "existing6475HoldoutCount": base_holdout_count,
            "existing6475HoldoutExamples": base_holdout_examples,
        },
        "rawFiveMountainHoldoutStatus": (
            "zero-overlap"
            if five_holdout_count == 0
            else "raw Five Mountain overlaps the independent holdout; those records must be excluded from v14 training"
        ),
        "duplicates": {
            "fiveMountain": duplicate_summary(five_records),
            "existing6475": duplicate_summary(base_records),
        },
        "decisionNote": decision_note,
    }
    (out_dir / "five-mountain-inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.strict_raw_five_holdout_zero and five_holdout_count != 0:
        raise RuntimeError(f"Five Mountain intersects the independent holdout: {five_holdout_count}")

    holdout_keys = set(holdout_aliases)
    merged: list[dict[str, Any]] = []
    excluded_base_holdout: list[dict[str, Any]] = []
    excluded_five_holdout: list[dict[str, Any]] = []
    skipped_five_duplicates: list[dict[str, Any]] = []
    merged_aliases: dict[str, dict[str, Any]] = {}

    for record in base_records:
        aliases = record_aliases(record)
        if aliases & holdout_keys:
            excluded_base_holdout.append(record)
            continue
        merged.append(record)
        for alias in aliases:
            merged_aliases.setdefault(alias, record)

    for record in five_records:
        aliases = record_aliases(record)
        if aliases & holdout_keys:
            excluded_five_holdout.append(record)
            continue
        matches = sorted(aliases & set(merged_aliases))
        if matches:
            skipped_five_duplicates.append({
                "photoId": record.get("photoId"),
                "dataset": record.get("dataset"),
                "matchedAliases": matches[:8],
                "matchedExistingPhotoId": merged_aliases[matches[0]].get("photoId"),
                "matchedExistingDataset": merged_aliases[matches[0]].get("dataset"),
            })
            continue
        merged.append(record)
        for alias in aliases:
            merged_aliases.setdefault(alias, record)

    with merged_path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in merged:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    merged_sha = sha256(merged_path)
    merge_report = {
        "schemaVersion": "framecull-five-mountain-v14-merge-report-v1",
        "baseTeacher": str(base_path),
        "baseTeacherSha256": base_sha,
        "baseTeacherRecordCount": len(base_records),
        "fiveTeacher": str(five_path),
        "fiveTeacherRecordCount": len(five_records),
        "holdoutCsv": str(holdout_path),
        "mergedTeacher": str(merged_path),
        "mergedTeacherSha256": merged_sha,
        "mergedTeacherRecordCount": len(merged),
        "excludedExisting6475HoldoutCount": len(excluded_base_holdout),
        "excludedFiveMountainHoldoutCount": len(excluded_five_holdout),
        "skippedFiveMountainDuplicateCount": len(skipped_five_duplicates),
        "skippedFiveMountainDuplicateExamples": skipped_five_duplicates[:30],
        "holdoutExcludedVerified": not any(record_aliases(row) & holdout_keys for row in merged),
        "trainingSetHoldoutIntersectionCount": sum(1 for row in merged if record_aliases(row) & holdout_keys),
        "rawFiveMountainHoldoutIntersectionCount": five_holdout_count,
        "rawFiveMountainHoldoutStatus": (
            "zero-overlap"
            if five_holdout_count == 0
            else "raw Five Mountain overlap was found and excluded before writing the v14 merged teacher"
        ),
        "fiveMountainHoldoutIntersectionVerifiedZero": five_holdout_count == 0,
        "trainingFiveMountainHoldoutIntersectionVerifiedZero": len(excluded_five_holdout) == five_holdout_count,
        "fiveMountainExisting6475IntersectionCount": five_base_count,
        "summaryAll": summarize_records(merged),
        "splitDistribution": split_distribution(merged, args.val_frac, args.seed),
        "decisionNote": decision_note,
    }
    (out_dir / "merge-report-v14.json").write_text(json.dumps(merge_report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "inventory": str(out_dir / "five-mountain-inventory.json"),
        "mergeReport": str(out_dir / "merge-report-v14.json"),
        "mergedTeacher": str(merged_path),
        "mergedTeacherSha256": merged_sha,
        "mergedTeacherRecordCount": len(merged),
        "fiveMountainHoldoutIntersection": five_holdout_count,
        "fiveMountainExisting6475Intersection": five_base_count,
        "fiveMountainHardNegatives": five_summary["hardNegativeCount"],
        "fiveMountainFalseRegionSamples": five_summary["faceLikeFalseRegionSampleCount"],
        "fiveMountainFalseRegions": five_summary["faceLikeFalseRegionCount"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
