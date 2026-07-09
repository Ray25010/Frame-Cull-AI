#!/usr/bin/env python
"""Inspect Semantic Teacher output lineage against the current Phase 0 input."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_expected_ids(input_path: Path) -> set[str]:
    items = json.loads(input_path.read_text(encoding="utf-8"))
    expected: set[str] = set()
    for item in items:
        if item.get("teacherImagePath") and item.get("dataset") and item.get("photoId"):
            expected.add(f"{item['dataset']}::{item['photoId']}")
    return expected


def inspect_output(output_path: Path, expected_ids: set[str]) -> dict[str, Any]:
    if not output_path.exists():
        return {
            "exists": False,
            "lineCount": 0,
            "uniqueRows": 0,
            "invalidRows": 0,
            "missingKeyRows": 0,
            "unknownRows": 0,
            "duplicateRows": 0,
            "resumeSafe": False,
            "reason": "output-missing",
        }
    unique_ids: set[str] = set()
    line_count = 0
    invalid_rows = 0
    missing_key_rows = 0
    unknown_rows = 0
    duplicate_rows = 0
    with output_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            line_count += 1
            try:
                row = json.loads(text)
            except json.JSONDecodeError:
                invalid_rows += 1
                continue
            dataset = row.get("dataset")
            photo_id = row.get("photoId")
            if not dataset or not photo_id:
                missing_key_rows += 1
                continue
            key = f"{dataset}::{photo_id}"
            if key not in expected_ids:
                unknown_rows += 1
                continue
            if key in unique_ids:
                duplicate_rows += 1
                continue
            unique_ids.add(key)
    resume_safe = all(
        value == 0
        for value in (invalid_rows, missing_key_rows, unknown_rows, duplicate_rows)
    )
    reason = "ok" if resume_safe else "output-invalid"
    return {
        "exists": True,
        "lineCount": line_count,
        "uniqueRows": len(unique_ids),
        "invalidRows": invalid_rows,
        "missingKeyRows": missing_key_rows,
        "unknownRows": unknown_rows,
        "duplicateRows": duplicate_rows,
        "resumeSafe": resume_safe,
        "reason": reason,
    }


def inspect_summary(
    summary_path: Path,
    output_path: Path,
    *,
    expected_count: int,
    input_sha256: str | None,
    output_unique_rows: int,
    output_line_count: int,
) -> dict[str, Any]:
    if not summary_path.exists():
        return {
            "exists": False,
            "resumeSafe": False,
            "reason": "summary-missing",
            "progress": 0,
        }
    try:
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
    except Exception as error:
        return {
            "exists": True,
            "resumeSafe": False,
            "reason": f"summary-invalid:{error}",
            "progress": 0,
        }
    same_output = Path(str(payload.get("output") or "")) == output_path
    same_items = int(payload.get("items") or 0) == expected_count
    summary_sha = payload.get("inputSha256")
    same_sha = (summary_sha is None) or (summary_sha == input_sha256)
    mtime_ok = (not output_path.exists()) or summary_path.stat().st_mtime >= output_path.stat().st_mtime
    resume_safe = all((same_output, same_items, same_sha, mtime_ok))
    progress = 0
    if resume_safe:
        progress = max(
            output_unique_rows,
            int(payload.get("completed") or 0),
            output_line_count + int(payload.get("failures") or 0),
        )
    reasons: list[str] = []
    if not same_output:
        reasons.append("output-mismatch")
    if not same_items:
        reasons.append(f"item-count-mismatch:{payload.get('items')}!={expected_count}")
    if not same_sha:
        reasons.append("input-sha-mismatch")
    if not mtime_ok:
        reasons.append("summary-older-than-output")
    return {
        "exists": True,
        "resumeSafe": resume_safe,
        "reason": "ok" if resume_safe else ",".join(reasons) or "summary-invalid",
        "progress": progress,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    args = parser.parse_args()

    expected_ids = load_expected_ids(args.input)
    input_sha = sha256(args.input)
    output_state = inspect_output(args.output, expected_ids)
    summary_state = inspect_summary(
        args.summary,
        args.output,
        expected_count=len(expected_ids),
        input_sha256=input_sha,
        output_unique_rows=int(output_state["uniqueRows"]),
        output_line_count=int(output_state["lineCount"]),
    )
    payload = {
        "inputPath": str(args.input),
        "outputPath": str(args.output),
        "summaryPath": str(args.summary),
        "expected": len(expected_ids),
        "inputSha256": input_sha,
        "output": output_state,
        "summary": summary_state,
        "resumeSafe": bool(summary_state["resumeSafe"] or output_state["resumeSafe"]),
        "progress": int(summary_state["progress"] if summary_state["resumeSafe"] else output_state["uniqueRows"]),
        "reason": summary_state["reason"] if summary_state["resumeSafe"] else output_state["reason"] if output_state["resumeSafe"] else summary_state["reason"] if summary_state["exists"] else output_state["reason"],
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
