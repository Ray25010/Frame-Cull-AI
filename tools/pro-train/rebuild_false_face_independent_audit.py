#!/usr/bin/env python
"""Rebuild the v13 independent holdout audit from the confirmed holdout CSV.

Why this exists:
- the independent holdout CSV is the authoritative label surface
- the audit JSON is only an inference input carrier
- if the audit drifts, preflight and later v13 retests can silently use the
  wrong sample set

This tool rewrites the audit so its `photoSummaries` exactly match the CSV
photoId list and ordering, while borrowing the best available `imagePath`
evidence from existing raw/audit JSON outputs.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


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


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_source_map(paths: list[Path]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in paths:
        payload = read_json(path)
        rows: list[dict[str, Any]] = []
        if isinstance(payload, dict):
            if isinstance(payload.get("photoSummaries"), list):
                rows = [row for row in payload["photoSummaries"] if isinstance(row, dict)]
            elif isinstance(payload.get("results"), list):
                rows = [row for row in payload["results"] if isinstance(row, dict)]
        for row in rows:
            key = stem_key(row.get("photoId") or row.get("id") or row.get("imagePath"))
            if key and key not in out:
                out[key] = row
    return out


def fallback_file_name(row: dict[str, str], source_row: dict[str, Any] | None) -> str:
    if source_row:
        value = str(source_row.get("fileName") or "").strip()
        if value:
            return value
        image_path = str(source_row.get("imagePath") or "").strip()
        if image_path:
            return Path(image_path).name
    absolute = str(row.get("absolutePath") or "").strip()
    if absolute:
        return Path(absolute).name
    return f"{row['photoId']}.JPG"


def fallback_image_path(row: dict[str, str], source_row: dict[str, Any] | None) -> str:
    if source_row:
        value = str(source_row.get("imagePath") or "").strip()
        if value:
            return value
    absolute = str(row.get("absolutePath") or "").strip()
    if absolute:
        return absolute
    file_name = fallback_file_name(row, source_row)
    return f"UPLOAD_REQUIRED/{file_name}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--independent-set", required=True)
    parser.add_argument("--source-json", action="append", default=[])
    parser.add_argument("--output", required=True)
    parser.add_argument("--summary-json", default="")
    args = parser.parse_args()

    independent_set_path = Path(args.independent_set)
    output_path = Path(args.output)
    source_paths = [Path(item) for item in args.source_json]

    independent_rows = read_csv(independent_set_path)
    source_map = load_source_map(source_paths)

    photo_summaries: list[dict[str, Any]] = []
    missing_source_rows: list[str] = []
    placeholder_rows: list[str] = []
    explicit_path_rows: list[str] = []

    for row in independent_rows:
        photo_id = str(row.get("photoId") or "").strip()
        key = stem_key(photo_id)
        source_row = source_map.get(key)
        if source_row is None:
            missing_source_rows.append(photo_id)
        image_path = fallback_image_path(row, source_row)
        if image_path.upper().startswith("UPLOAD_REQUIRED/"):
            placeholder_rows.append(photo_id)
        else:
            explicit_path_rows.append(photo_id)
        photo_summaries.append(
            {
                "id": photo_id,
                "photoId": photo_id,
                "imagePath": image_path,
                "fileName": fallback_file_name(row, source_row),
                "sampleRole": str(row.get("sampleRole") or "").strip(),
                "scene": str(row.get("scene") or "").strip(),
            }
        )

    payload = {
        "photoSummaries": photo_summaries,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "schemaVersion": "framecull-false-face-independent-audit-rebuild-v1",
        "independentSet": str(independent_set_path),
        "sourceJsons": [str(path) for path in source_paths],
        "output": str(output_path),
        "count": len(photo_summaries),
        "missingSourceRows": missing_source_rows,
        "placeholderRows": placeholder_rows,
        "explicitPathRows": explicit_path_rows[:20],
    }
    if args.summary_json:
        summary_path = Path(args.summary_json)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
