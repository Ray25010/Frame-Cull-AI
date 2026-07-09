#!/usr/bin/env python
"""Check v13 independent holdout photoIds against the teacher train+val universe."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any, Iterable


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


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if text:
                yield json.loads(text)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def collect_teacher_ids(path: Path) -> set[str]:
    ids: set[str] = set()
    for row in iter_jsonl(path):
        for field in ("photoId", "imagePath", "studentPreviewPath", "teacherImagePath", "sourcePath"):
            key = stem_key(row.get(field))
            if key:
                ids.add(key)
    return ids


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher-jsonl", required=True)
    parser.add_argument("--independent-set", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    teacher_path = Path(args.teacher_jsonl)
    independent_path = Path(args.independent_set)
    teacher_ids = collect_teacher_ids(teacher_path)
    rows = read_csv(independent_path)
    independent_ids = [stem_key(row.get("photoId")) for row in rows if stem_key(row.get("photoId"))]
    overlap = sorted(set(independent_ids) & teacher_ids)
    payload = {
        "schemaVersion": "framecull-false-face-generalization-v13-overlap-check-v2",
        "teacherJsonl": str(teacher_path),
        "independentSetPath": str(independent_path),
        "teacherRecordCount": len(teacher_ids),
        "independentSetCount": len(independent_ids),
        "independentSetOverlapCount": len(overlap),
        "independentSetOverlapExamples": overlap[:50],
        "independentSetZeroOverlapOk": len(overlap) == 0,
        "overlapCount": len(overlap),
        "ok": len(overlap) == 0,
        "acceptanceNote": "Independent set photoIds must have zero overlap with the v12 teacher train+val universe.",
    }
    output_path = Path(args.output_json)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
