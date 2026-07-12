#!/usr/bin/env python
"""Audit Semantic Teacher JSONL outputs and write QA reports."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any

from semantic_teacher_schema import validate_jsonl


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            yield json.loads(line)


def score_bucket(value: float) -> str:
    if value < 0.2:
        return "0.0-0.2"
    if value < 0.4:
        return "0.2-0.4"
    if value < 0.6:
        return "0.4-0.6"
    if value < 0.8:
        return "0.6-0.8"
    return "0.8-1.0"


def build_report(records: list[dict[str, Any]], validation: dict[str, Any], flat: bool) -> dict[str, Any]:
    scene_counts = Counter(record.get("sceneType", "unknown") for record in records)
    dataset_counts = Counter(record.get("dataset", "unknown") for record in records)
    uncertain = [record for record in records if record.get("uncertain")]
    trace_counts = [len(record.get("reasoningTrace") or []) for record in records]
    face_verdict_counts = [len(record.get("faceRegionVerdicts") or []) for record in records]
    human_face_missing_verdicts = [
        record
        for record in records
        if record.get("hasRealHumanFace") and not (record.get("faceRegionVerdicts") or [])
    ]
    keep_buckets = Counter(score_bucket(float(record.get("semanticKeepScore", 0.0))) for record in records)
    false_face_buckets = Counter(score_bucket(float(record.get("falseFaceRisk", 0.0))) for record in records)
    fallback_tags = Counter(
        tag
        for record in records
        for tag in (record.get("uncertain") or [])
        if isinstance(tag, str) and tag.startswith("faceRegionVerdicts_")
    )
    qa_samples = sorted(
        records,
        key=lambda row: (
            -len(row.get("uncertain") or []),
            -float(row.get("falseFaceRisk", 0.0)),
            abs(float(row.get("semanticKeepScore", 0.5)) - 0.5),
        ),
    )[:100]
    return {
        "schemaVersion": "framecull-semantic-teacher-quality-v1",
        "flatScalar": flat,
        "total": len(records),
        "validation": validation,
        "datasetCounts": dict(dataset_counts),
        "sceneCounts": dict(scene_counts),
        "uncertainCount": len(uncertain),
        "traceCoverage": sum(1 for count in trace_counts if count > 0) / max(1, len(records)),
        "faceVerdictCoverage": sum(1 for count in face_verdict_counts if count > 0) / max(1, len(records)),
        "humanFaceMissingVerdicts": len(human_face_missing_verdicts),
        "semanticKeepBuckets": dict(sorted(keep_buckets.items())),
        "falseFaceRiskBuckets": dict(sorted(false_face_buckets.items())),
        "fallbackTags": dict(sorted(fallback_tags.items())),
        "qaSamples": [
            {
                "dataset": row.get("dataset"),
                "photoId": row.get("photoId"),
                "sceneType": row.get("sceneType"),
                "semanticKeepScore": row.get("semanticKeepScore"),
                "falseFaceRisk": row.get("falseFaceRisk"),
                "uncertain": row.get("uncertain"),
                "keepReasons": row.get("keepReasons"),
                "rejectReasons": row.get("rejectReasons"),
                "imagePath": row.get("imagePath"),
            }
            for row in qa_samples
        ],
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# FrameCull Semantic Teacher Quality Report",
        "",
        f"- Records: `{report['total']}`",
        f"- Flat scalar ablation: `{report['flatScalar']}`",
        f"- Schema passed: `{report['validation']['passed']}`",
        f"- Schema failures: `{report['validation']['failed']}`",
        f"- Reasoning trace coverage: `{report['traceCoverage']:.1%}`",
        f"- Face verdict coverage: `{report['faceVerdictCoverage']:.1%}`",
        f"- Human-face rows missing verdicts: `{report['humanFaceMissingVerdicts']}`",
        f"- Uncertain records: `{report['uncertainCount']}`",
        f"- Face fallback tags: `{report['fallbackTags']}`",
        "",
        "## Dataset Counts",
        "",
        "| Dataset | Count |",
        "|---|---:|",
    ]
    for key, value in sorted(report["datasetCounts"].items()):
        lines.append(f"| `{key}` | {value} |")
    lines += ["", "## Scene Counts", "", "| Scene | Count |", "|---|---:|"]
    for key, value in sorted(report["sceneCounts"].items()):
        lines.append(f"| `{key}` | {value} |")
    lines += ["", "## Semantic Keep Buckets", "", "| Bucket | Count |", "|---|---:|"]
    for key, value in sorted(report["semanticKeepBuckets"].items()):
        lines.append(f"| `{key}` | {value} |")
    lines += ["", "## QA Samples", "", "| Dataset | Photo | Scene | Keep | False face | Uncertain |", "|---|---|---|---:|---:|---|"]
    for row in report["qaSamples"][:40]:
        lines.append(
            f"| `{row['dataset']}` | `{row['photoId']}` | `{row['sceneType']}` | "
            f"{row['semanticKeepScore']} | {row['falseFaceRisk']} | `{row['uncertain']}` |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--flat-scalar", action="store_true")
    args = parser.parse_args()
    records = list(iter_jsonl(args.teacher))
    validation = validate_jsonl(args.teacher, allow_flat_scalar=args.flat_scalar)
    report = build_report(records, validation, args.flat_scalar)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "teacher-quality-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out / "teacher-quality-report.md", report)
    with (args.out / "teacher-qa-samples.csv").open("w", newline="", encoding="utf-8") as handle:
        fieldnames = ["dataset", "photoId", "sceneType", "semanticKeepScore", "falseFaceRisk", "uncertain", "imagePath"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in report["qaSamples"]:
            writer.writerow({key: row.get(key) for key in fieldnames})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if validation["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
