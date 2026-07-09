#!/usr/bin/env python3
"""Inspect face-region fields in a semantic teacher JSONL file."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()

    total = 0
    with_regions = 0
    verdict_count = 0
    dataset_counts: Counter[str] = Counter()
    region_key_counts: Counter[str] = Counter()
    real_counts: Counter[str] = Counter()
    samples: list[dict[str, Any]] = []

    with args.teacher.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            total += 1
            record = json.loads(line)
            verdicts = record.get("faceRegionVerdicts") or []
            if verdicts:
                with_regions += 1
                dataset_counts[str(record.get("dataset") or "unknown")] += 1
            if isinstance(verdicts, list):
                verdict_count += len(verdicts)
                for verdict in verdicts:
                    if isinstance(verdict, dict):
                        region_key_counts.update(verdict.keys())
                        real_counts[str(verdict.get("isRealHumanFace"))] += 1
                if len(samples) < args.limit:
                    samples.append(
                        {
                            "recordKeys": sorted(record.keys()),
                            "dataset": record.get("dataset"),
                            "stem": record.get("stem"),
                            "path": record.get("path"),
                            "photoId": record.get("photoId"),
                            "faceRegionVerdicts": verdicts[:3],
                        }
                    )

    print(
        json.dumps(
            {
                "teacher": str(args.teacher),
                "exists": args.teacher.exists(),
                "totalRecords": total,
                "recordsWithFaceRegionVerdicts": with_regions,
                "faceRegionVerdictCount": verdict_count,
                "datasetCounts": dict(dataset_counts),
                "regionKeys": dict(region_key_counts.most_common()),
                "isRealHumanFaceCounts": dict(real_counts),
                "samples": samples,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
