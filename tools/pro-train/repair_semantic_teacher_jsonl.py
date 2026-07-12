#!/usr/bin/env python
"""Normalize and repair Semantic Teacher JSONL outputs into the current schema."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from semantic_teacher_schema import normalize_record, validate_record


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_no, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            yield line_no, text


def repair_jsonl(input_path: Path, output_path: Path, *, allow_flat_scalar: bool) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    repaired = 0
    invalid_source = 0
    face_fallback = 0
    trace_fallback = 0
    scene_normalized = 0

    with input_path.open("r", encoding="utf-8", errors="replace") as src, output_path.open("w", encoding="utf-8") as dst:
        for line_no, line in enumerate(src, 1):
            text = line.strip()
            if not text:
                continue
            total += 1
            try:
                record = json.loads(text)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"invalid json at line {line_no}: {exc}") from exc

            source_errors = validate_record(record, allow_flat_scalar=allow_flat_scalar)
            if source_errors:
                invalid_source += 1

            normalized = normalize_record(record, flat_scalar=allow_flat_scalar)
            normalized_errors = validate_record(normalized, allow_flat_scalar=allow_flat_scalar)
            if normalized_errors:
                preview = ", ".join(normalized_errors[:5])
                raise SystemExit(f"normalized record still invalid at line {line_no}: {preview}")

            uncertain = {str(item) for item in normalized.get("uncertain") or []}
            if any(
                token in uncertain
                for token in (
                    "faceRegionVerdicts_fallback",
                    "faceRegionVerdicts_positive_fallback",
                    "faceRegionVerdicts_false_fallback",
                    "faceRegionVerdicts_false_suppressed",
                )
            ):
                face_fallback += 1
            if "reasoningTrace_fallback" in uncertain:
                trace_fallback += 1
            if any(item.startswith("sceneType_normalized_from:") for item in uncertain):
                scene_normalized += 1
            if normalized != record:
                repaired += 1

            dst.write(json.dumps(normalized, ensure_ascii=False) + "\n")

    return {
        "input": str(input_path),
        "output": str(output_path),
        "allowFlatScalar": allow_flat_scalar,
        "total": total,
        "repaired": repaired,
        "invalidSourceRecords": invalid_source,
        "faceFallbackRecords": face_fallback,
        "traceFallbackRecords": trace_fallback,
        "sceneNormalizedRecords": scene_normalized,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--allow-flat-scalar", action="store_true")
    args = parser.parse_args()

    summary = repair_jsonl(
        args.input,
        args.output,
        allow_flat_scalar=args.allow_flat_scalar,
    )
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
