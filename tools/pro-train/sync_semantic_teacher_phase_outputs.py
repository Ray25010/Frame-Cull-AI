#!/usr/bin/env python
"""Rebuild/sync Semantic Teacher Phase 2 outputs to match the task spec.

This helper is intentionally lightweight:
- rebuilds missing teacher run summaries from the current JSONL output
- materializes a canonical grounded teacher-failures.csv alias
- mirrors QA sample CSVs into the Phase 2 teacher-qa-samples directory
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path
from typing import Any


FAILURE_HEADERS = ["dataset", "photoId", "teacherImagePath", "error"]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def count_nonempty_lines(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return sum(1 for line in handle if line.strip())


def read_last_jsonl_record(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    last: dict[str, Any] | None = None
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            try:
                last = json.loads(text)
            except json.JSONDecodeError:
                continue
    return last


def count_failure_rows(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return sum(1 for _ in reader)


def ensure_csv_with_header(path: Path, headers: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()


def infer_backend(model_id: str | None) -> str:
    text = str(model_id or "").strip().lower()
    if "qwen" in text:
        return "qwen2_5_vl"
    if "heuristic" in text:
        return "heuristic"
    return "unknown"


def rebuild_summary(
    *,
    input_path: Path,
    output_path: Path,
    summary_path: Path,
    failures_path: Path,
    flat_scalar: bool,
) -> bool:
    if not output_path.exists() or summary_path.exists():
        return False
    items = load_json(input_path) if input_path.exists() else []
    teacher_items = [item for item in items if item.get("teacherImagePath")]
    preview_fallback_items = [item for item in teacher_items if item.get("teacherImageIsPreviewFallback")]
    success_lines = count_nonempty_lines(output_path)
    failure_count = count_failure_rows(failures_path)
    last = read_last_jsonl_record(output_path)
    model_id = str((last or {}).get("teacherModel") or "")
    summary = {
        "schemaVersion": "framecull-semantic-teacher-run-v1",
        "backend": infer_backend(model_id),
        "model": model_id or "unknown",
        "flatScalar": flat_scalar,
        "input": str(input_path),
        "inputSha256": "",
        "output": str(output_path),
        "items": len(teacher_items),
        "previewFallbackInputs": len(preview_fallback_items),
        "written": success_lines,
        "writtenThisRun": 0,
        "successLines": success_lines,
        "completed": success_lines + failure_count,
        "remaining": max(0, len(teacher_items) - (success_lines + failure_count)),
        "failures": failure_count,
        "elapsedS": 0.0,
        "currentIndex": success_lines + failure_count,
        "currentKey": f"{last.get('dataset')}::{last.get('photoId')}" if last and last.get("dataset") and last.get("photoId") else None,
        "interrupted": success_lines + failure_count < len(teacher_items),
        "interruptedReason": "reconstructed_from_existing_output" if success_lines + failure_count < len(teacher_items) else None,
        "reconstructedFromExistingOutput": True,
    }
    if input_path.exists():
        import hashlib

        digest = hashlib.sha256()
        with input_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        summary["inputSha256"] = digest.hexdigest()
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def sync_failure_alias(ground_failures: Path, canonical_failures: Path) -> None:
    canonical_failures.parent.mkdir(parents=True, exist_ok=True)
    if ground_failures.exists():
        shutil.copy2(ground_failures, canonical_failures)
    else:
        ensure_csv_with_header(canonical_failures, FAILURE_HEADERS)


def copy_if_exists(source: Path, target: Path) -> bool:
    if not source.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return True


def sync_phase_outputs(lab: Path) -> dict[str, Any]:
    feature_dir = lab / "features" / "semantic-teacher"
    phase0_input = lab / "outputs" / "semantic-teacher-lab" / "phase0" / "all-images.json"
    grounded_output = feature_dir / "semantic-teacher-v1.jsonl"
    grounded_summary = feature_dir / "semantic-teacher-v1.summary.json"
    grounded_failures = feature_dir / "semantic-teacher-v1.failures.csv"
    flat_output = feature_dir / "semantic-teacher-v1-flat.jsonl"
    flat_summary = feature_dir / "semantic-teacher-v1-flat.summary.json"
    flat_failures = feature_dir / "semantic-teacher-v1-flat.failures.csv"

    rebuilt = {
        "groundedSummary": rebuild_summary(
            input_path=phase0_input,
            output_path=grounded_output,
            summary_path=grounded_summary,
            failures_path=grounded_failures,
            flat_scalar=False,
        ),
        "flatSummary": rebuild_summary(
            input_path=phase0_input,
            output_path=flat_output,
            summary_path=flat_summary,
            failures_path=flat_failures,
            flat_scalar=True,
        ),
    }

    canonical_failures = feature_dir / "teacher-failures.csv"
    sync_failure_alias(grounded_failures, canonical_failures)

    qa_root = feature_dir / "teacher-qa-samples"
    qa_root.mkdir(parents=True, exist_ok=True)
    grounded_qa_csv = lab / "outputs" / "semantic-teacher-lab" / "teacher-qa-grounded-full" / "teacher-qa-samples.csv"
    flat_qa_csv = lab / "outputs" / "semantic-teacher-lab" / "teacher-qa-flat-full" / "teacher-qa-samples.csv"
    copied = {
        "groundedQaSamples": copy_if_exists(grounded_qa_csv, qa_root / "grounded-teacher-qa-samples.csv"),
        "flatQaSamples": copy_if_exists(flat_qa_csv, qa_root / "flat-teacher-qa-samples.csv"),
    }

    return {
        "schema": "framecull-semantic-phase-output-sync-v1",
        "lab": str(lab),
        "rebuilt": rebuilt,
        "copied": copied,
        "teacherFailures": str(canonical_failures),
        "teacherQaSamplesDir": str(qa_root),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", type=Path, default=Path("/data/FrameCullModelLab"))
    args = parser.parse_args()
    payload = sync_phase_outputs(args.lab)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
