#!/usr/bin/env python
"""Audit v13 false-face generalization artifacts against the task contract."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


REQUIRED_FALSE_FACE_SCENES = {"landscape", "product_object", "empty_scene", "event", "food"}


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def exists(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 0


def verdict(ok: bool, evidence: str, detail: Any = None) -> dict[str, Any]:
    return {
        "status": "pass" if ok else "fail",
        "evidence": evidence,
        "detail": detail,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval-dir", default="output/semantic-false-face-diagnosis/v13-eval")
    parser.add_argument("--output-json", default="")
    args = parser.parse_args()

    eval_dir = Path(args.eval_dir)
    independent_path = eval_dir / "independent-false-face-set.csv"
    overlap_path = eval_dir / "overlap-check.json"
    v12_scores_path = eval_dir / "v12-generalization-scores.csv"
    v13_scores_path = eval_dir / "v13-generalization-scores.csv"
    report_path = eval_dir / "false-face-generalization-report.md"
    training_report_path = eval_dir / "training-report-v13.json"
    preflight_path = eval_dir / "phase3-preflight.actual.json"

    checks: dict[str, Any] = {}

    independent_rows = read_csv(independent_path) if exists(independent_path) else []
    false_rows = [row for row in independent_rows if row.get("sampleRole") == "false_face_positive"]
    control_rows = [row for row in independent_rows if row.get("sampleRole") == "real_face_control"]
    false_scene_counts = Counter(str(row.get("scene") or "") for row in false_rows)
    missing_scenes = sorted(scene for scene in REQUIRED_FALSE_FACE_SCENES if false_scene_counts.get(scene, 0) <= 0)
    manual_ok = all(str(row.get("manualLabel") or "").strip() == "human-confirmed" for row in independent_rows)
    complete_fields = all(
        str(row.get(field) or "").strip()
        for row in independent_rows
        for field in ("photoId", "sampleRole", "hasRealHumanFace", "scene", "illusionReason", "manualLabel")
    )
    checks["independent_set_counts"] = verdict(
        30 <= len(false_rows) <= 60 and 20 <= len(control_rows) <= 30,
        str(independent_path),
        {"falseFacePositive": len(false_rows), "realFaceControl": len(control_rows), "total": len(independent_rows)},
    )
    checks["independent_set_scene_coverage"] = verdict(
        not missing_scenes,
        str(independent_path),
        {"falseFaceSceneCounts": dict(sorted(false_scene_counts.items())), "missingScenes": missing_scenes},
    )
    checks["independent_set_manual_labels"] = verdict(
        bool(independent_rows) and manual_ok and complete_fields,
        str(independent_path),
        {"manualOk": manual_ok, "completeFields": complete_fields},
    )

    overlap = read_json(overlap_path) if exists(overlap_path) else {}
    overlap_ok = (
        bool(overlap.get("independentSetZeroOverlapOk"))
        or (overlap.get("overlapCount") == 0 and bool(overlap.get("ok")))
    )
    checks["zero_overlap"] = verdict(
        overlap_ok,
        str(overlap_path),
        {
            "independentSetZeroOverlapOk": overlap.get("independentSetZeroOverlapOk"),
            "independentSetOverlapCount": overlap.get("independentSetOverlapCount"),
            "overlapCount": overlap.get("overlapCount"),
            "ok": overlap.get("ok"),
        },
    )

    v12_scores = read_csv(v12_scores_path) if exists(v12_scores_path) else []
    checks["v12_scores_reported"] = verdict(
        len(v12_scores) == len(independent_rows) and len(v12_scores) > 0,
        str(v12_scores_path),
        {"scores": len(v12_scores), "independentRows": len(independent_rows)},
    )

    report_text = report_path.read_text(encoding="utf-8", errors="replace") if exists(report_path) else ""
    checks["final_report_exists"] = verdict(
        bool(report_text.strip()) and ("未闭环" in report_text or "闭环" in report_text),
        str(report_path),
        {"bytes": report_path.stat().st_size if report_path.exists() else 0},
    )

    v13_scores = read_csv(v13_scores_path) if exists(v13_scores_path) else []
    training_report = read_json(training_report_path) if exists(training_report_path) else {}
    preflight = read_json(preflight_path) if exists(preflight_path) else {}
    checks["phase3_retrain_if_needed"] = verdict(
        exists(v13_scores_path) and exists(training_report_path) and preflight.get("status") == "ok",
        f"{v13_scores_path}; {training_report_path}; {preflight_path}",
        {"v13Scores": len(v13_scores), "preflightStatus": preflight.get("status"), "trainingReportKeys": sorted(training_report.keys())[:12]},
    )

    all_ok = all(item["status"] == "pass" for item in checks.values())
    payload = {
        "schemaVersion": "framecull-false-face-v13-completion-audit-v1",
        "status": "pass" if all_ok else "fail",
        "evalDir": str(eval_dir),
        "checks": checks,
    }
    output_path = Path(args.output_json) if args.output_json else eval_dir / "v13-completion-audit.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
