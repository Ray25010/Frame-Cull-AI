#!/usr/bin/env python
"""Merge patched semantic-teacher rows back into a full grounded teacher JSONL.

The default use case is:
- baseline full grounded teacher JSONL
- patched subset JSONL with the same schemaVersion and overlapping photoIds
- optional patch subset manifest for reporting only

The output is a merged teacher JSONL that keeps untouched rows from baseline,
replaces patched rows by photoId, and writes a compact merge report.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            rows.append(json.loads(text))
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def photo_id_of(row: dict[str, Any]) -> str:
    return str(row.get("photoId") or "").strip()


def summarize_scene(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for row in rows:
        scene = str(row.get("sceneType") or "other")
        counts[scene] = counts.get(scene, 0) + 1
    return dict(sorted(counts.items()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--patched", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    baseline_rows = read_jsonl(args.baseline)
    patched_rows = read_jsonl(args.patched)
    patched_map = {photo_id_of(row): row for row in patched_rows if photo_id_of(row)}

    merged_rows: list[dict[str, Any]] = []
    replaced = 0
    untouched = 0
    for row in baseline_rows:
        pid = photo_id_of(row)
        if pid and pid in patched_map:
            merged_rows.append(patched_map[pid])
            replaced += 1
        else:
            merged_rows.append(row)
            untouched += 1

    baseline_ids = {photo_id_of(row) for row in baseline_rows if photo_id_of(row)}
    patched_ids = {photo_id_of(row) for row in patched_rows if photo_id_of(row)}
    missing_in_baseline = sorted(pid for pid in patched_ids if pid not in baseline_ids)
    extra_in_baseline = sorted(pid for pid in baseline_ids if pid not in patched_ids)

    write_jsonl(args.out, merged_rows)
    report = {
        "schemaVersion": "framecull-semantic-teacher-merge-report-v1",
        "baseline": str(args.baseline),
        "patched": str(args.patched),
        "output": str(args.out),
        "baselineCount": len(baseline_rows),
        "patchedCount": len(patched_rows),
        "mergedCount": len(merged_rows),
        "replacedCount": replaced,
        "untouchedCount": untouched,
        "patchedPhotoIdsMatched": replaced,
        "patchedPhotoIdsMissingFromBaseline": len(missing_in_baseline),
        "baselinePhotoIdsNotPatched": len(extra_in_baseline),
        "missingInBaseline": missing_in_baseline[:50],
        "sceneSummary": summarize_scene(merged_rows),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
