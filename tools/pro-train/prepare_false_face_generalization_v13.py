#!/usr/bin/env python
"""Prepare zero-overlap candidate pools for false-face generalization v13.

This helper does not assign ground-truth labels. It only:
1. reads the v12 merged semantic teacher set to collect train/eval photoIds
2. scans one or more external candidate image directories
3. emits a zero-overlap candidate CSV for manual labeling
4. writes overlap-check.json proving the current candidate pool has no overlap

The final independent set still requires manual confirmation for:
- hasRealHumanFace
- sampleRole (false_face_positive / real_face_control)
- scene
- illusionReason
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Iterable


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".arw", ".nef", ".dng", ".cr2", ".cr3"}


def stem_key(value: str | Path) -> str:
    text = str(value).strip().strip('"').strip("'")
    if not text:
        return ""
    key = Path(text).stem.lower()
    while True:
        inner = Path(key).stem.lower()
        if inner == key:
            break
        key = inner
    return key


def iter_jsonl(path: Path) -> Iterable[dict]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            yield json.loads(text)


def collect_training_ids(teacher_jsonl: Path) -> tuple[set[str], list[str]]:
    ids: set[str] = set()
    collisions: set[str] = set()
    for row in iter_jsonl(teacher_jsonl):
        aliases = set()
        for field in ("photoId", "imagePath", "studentPreviewPath", "teacherImagePath", "sourcePath"):
            key = stem_key(row.get(field) or "")
            if key:
                aliases.add(key)
        for key in aliases:
            if key in ids:
                collisions.add(key)
            ids.add(key)
    return ids, sorted(collisions)


def scan_candidate_dirs(candidate_dirs: list[Path]) -> list[dict]:
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for directory in candidate_dirs:
        if not directory.exists():
            continue
        for path in sorted(directory.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXTS:
                continue
            photo_id = stem_key(path.name)
            if not photo_id:
                continue
            key = (str(directory), photo_id)
            if key in seen:
                continue
            seen.add(key)
            rows.append(
                {
                    "sourceDir": str(directory),
                    "relativePath": str(path.relative_to(directory)),
                    "fileName": path.name,
                    "photoId": photo_id,
                    "absolutePath": str(path),
                }
            )
    return rows


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "photoId",
        "sourceDir",
        "relativePath",
        "fileName",
        "absolutePath",
        "manualLabel",
        "hasRealHumanFace",
        "sampleRole",
        "scene",
        "illusionReason",
        "notes",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    **row,
                    "manualLabel": "",
                    "hasRealHumanFace": "",
                    "sampleRole": "",
                    "scene": "",
                    "illusionReason": "",
                    "notes": "",
                }
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--teacher-jsonl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--candidate-dir", action="append", default=[])
    args = parser.parse_args()

    teacher_jsonl = Path(args.teacher_jsonl)
    output_dir = Path(args.output_dir)
    candidate_dirs = [Path(item) for item in args.candidate_dir]

    training_ids, collisions = collect_training_ids(teacher_jsonl)
    scanned = scan_candidate_dirs(candidate_dirs)

    overlap_rows = [row for row in scanned if row["photoId"] in training_ids]
    zero_overlap_rows = [row for row in scanned if row["photoId"] not in training_ids]

    write_csv(output_dir / "independent-false-face-candidate-pool.csv", zero_overlap_rows)

    payload = {
        "schemaVersion": "framecull-false-face-generalization-v13-overlap-check-v1",
        "teacherJsonl": str(teacher_jsonl),
        "teacherRecordCount": len(training_ids),
        "teacherAliasCollisions": collisions[:100],
        "candidateDirs": [str(path) for path in candidate_dirs],
        "candidateFileCount": len(scanned),
        "zeroOverlapCandidateCount": len(zero_overlap_rows),
        "overlapCount": len(overlap_rows),
        "overlapExamples": overlap_rows[:50],
        "ok": len(overlap_rows) == 0,
        "note": "This only proves the scanned candidate pool is zero-overlap with the v12 teacher train+val universe. Final independent set still needs manual labels.",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "overlap-check.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
