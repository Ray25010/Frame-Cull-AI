#!/usr/bin/env python
"""Preflight Phase 3 false-face v13 without training.

This script validates the parts of the v13 Phase 3 pipeline that should be
correct before any expensive retraining starts:
- zero-overlap evidence files exist and are internally consistent
- shortlist confirmation state is visible
- teacher patch generation and merge can run on the chosen shortlist
- holdout audit rows can be resolved either by preview-dir copies or explicit
  non-placeholder image paths
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


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


def parse_bool(value: Any) -> bool:
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "y"}


def is_placeholder_path(value: str) -> bool:
    text = str(value or "").strip()
    if not text:
        return True
    upper = text.upper()
    return upper.startswith("UPLOAD_REQUIRED/")


def preview_exists(preview_dir: Path, photo_id: str) -> bool:
    for ext in (".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"):
        if (preview_dir / f"{photo_id}{ext}").exists():
            return True
    return False


def shortlist_summary(rows: list[dict[str, str]]) -> dict[str, Any]:
    filled = {
        "humanConfirmUseForTraining": sum(1 for row in rows if str(row.get("humanConfirmUseForTraining", "")).strip()),
        "humanConfirmHasRealHumanFace": sum(1 for row in rows if str(row.get("humanConfirmHasRealHumanFace", "")).strip()),
        "humanConfirmScene": sum(1 for row in rows if str(row.get("humanConfirmScene", "")).strip()),
        "humanConfirmIllusionReason": sum(1 for row in rows if str(row.get("humanConfirmIllusionReason", "")).strip()),
    }
    confirmed_ready = [
        row for row in rows
        if parse_bool(row.get("humanConfirmUseForTraining")) and not parse_bool(row.get("humanConfirmHasRealHumanFace"))
    ]
    return {
        "rows": len(rows),
        "filled": filled,
        "confirmedUseTrueCount": sum(1 for row in rows if parse_bool(row.get("humanConfirmUseForTraining"))),
        "confirmedNoRealFaceCount": sum(1 for row in rows if not parse_bool(row.get("humanConfirmHasRealHumanFace")) and str(row.get("humanConfirmHasRealHumanFace", "")).strip()),
        "confirmedReadyRowsCount": len(confirmed_ready),
        "confirmedReadyPhotoIds": [str(row.get("photoId", "")) for row in confirmed_ready[:20]],
    }


def independent_set_summary(rows: list[dict[str, str]]) -> dict[str, Any]:
    role_counts = Counter(str(row.get("sampleRole") or "") for row in rows)
    scene_counts = Counter(str(row.get("scene") or "") for row in rows)
    return {
        "count": len(rows),
        "roleCounts": dict(sorted(role_counts.items())),
        "sceneCounts": dict(sorted(scene_counts.items())),
    }


def audit_coverage(independent_rows: list[dict[str, str]], audit: dict[str, Any], preview_dir: Path) -> dict[str, Any]:
    summaries = list(audit.get("photoSummaries") or [])
    audit_map = {stem_key(row.get("photoId") or row.get("id")): row for row in summaries}
    unresolved: list[str] = []
    preview_resolved = 0
    explicit_path_count = 0
    explicit_path_local_exists = 0
    explicit_path_unverified = 0
    missing_from_audit: list[str] = []
    for row in independent_rows:
        pid = stem_key(row.get("photoId"))
        summary = audit_map.get(pid)
        if not summary:
            missing_from_audit.append(str(row.get("photoId") or ""))
            continue
        if preview_exists(preview_dir, str(row.get("photoId") or "")):
            preview_resolved += 1
            continue
        image_path = str(summary.get("imagePath") or "").strip()
        if not is_placeholder_path(image_path):
            explicit_path_count += 1
            if Path(image_path).exists():
                explicit_path_local_exists += 1
            else:
                explicit_path_unverified += 1
            continue
        unresolved.append(str(row.get("photoId") or ""))
    return {
        "auditRowCount": len(summaries),
        "mappedCount": len(independent_rows) - len(missing_from_audit),
        "previewResolvedCount": preview_resolved,
        "explicitAuditPathCount": explicit_path_count,
        "explicitAuditPathLocalExistsCount": explicit_path_local_exists,
        "explicitAuditPathUnverifiedCount": explicit_path_unverified,
        "missingFromAudit": missing_from_audit,
        "unresolvedPhotoIds": unresolved,
    }


def run_patch_and_merge(
    *,
    baseline_teacher: Path,
    shortlist: Path,
    holdout_ids: Path,
) -> dict[str, Any]:
    root = repo_root()
    build_script = root / "tools" / "pro-train" / "build_false_face_v13_teacher_patch.py"
    merge_script = root / "tools" / "pro-train" / "merge_semantic_teacher_patch.py"
    with tempfile.TemporaryDirectory(prefix="framecull-v13-preflight-") as tmp_dir:
        tmp = Path(tmp_dir)
        patch_jsonl = tmp / "patch.jsonl"
        patch_summary = tmp / "patch-summary.json"
        merged_teacher = tmp / "teacher-merged.jsonl"
        merge_report = tmp / "merge-report.json"

        build_cmd = [
            sys.executable,
            str(build_script),
            "--baseline-teacher",
            str(baseline_teacher),
            "--confirmed-shortlist",
            str(shortlist),
            "--holdout-ids",
            str(holdout_ids),
            "--output-jsonl",
            str(patch_jsonl),
            "--summary-json",
            str(patch_summary),
        ]
        build_run = subprocess.run(
            build_cmd,
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if build_run.returncode != 0:
            return {
                "buildOk": False,
                "buildReturnCode": build_run.returncode,
                "buildStdout": build_run.stdout[-4000:],
                "buildStderr": build_run.stderr[-4000:],
            }

        patch_payload = read_json(patch_summary)
        result: dict[str, Any] = {
            "buildOk": True,
            "patchSummary": patch_payload,
        }
        if int(patch_payload.get("patchedRows", 0)) <= 0:
            result["mergeOk"] = False
            result["mergeSkippedReason"] = "patchedRows<=0"
            return result

        merge_cmd = [
            sys.executable,
            str(merge_script),
            "--baseline",
            str(baseline_teacher),
            "--patched",
            str(patch_jsonl),
            "--out",
            str(merged_teacher),
            "--report",
            str(merge_report),
        ]
        merge_run = subprocess.run(
            merge_cmd,
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        result["mergeOk"] = merge_run.returncode == 0
        result["mergeReturnCode"] = merge_run.returncode
        result["mergeStdout"] = merge_run.stdout[-4000:]
        result["mergeStderr"] = merge_run.stderr[-4000:]
        if merge_run.returncode == 0 and merge_report.exists():
            result["mergeReport"] = read_json(merge_report)
        return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-teacher", required=True)
    parser.add_argument("--confirmed-shortlist", required=True)
    parser.add_argument("--holdout-ids", required=True)
    parser.add_argument("--independent-set", required=True)
    parser.add_argument("--independent-audit", required=True)
    parser.add_argument("--overlap-check", required=True)
    parser.add_argument("--preview-dir", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--mode-label", default="actual")
    args = parser.parse_args()

    baseline_teacher = Path(args.baseline_teacher)
    shortlist_path = Path(args.confirmed_shortlist)
    holdout_ids_path = Path(args.holdout_ids)
    independent_set_path = Path(args.independent_set)
    independent_audit_path = Path(args.independent_audit)
    overlap_check_path = Path(args.overlap_check)
    preview_dir = Path(args.preview_dir)
    output_json = Path(args.output_json)

    independent_rows = read_csv(independent_set_path)
    shortlist_rows = read_csv(shortlist_path)
    audit = read_json(independent_audit_path)
    overlap = read_json(overlap_check_path)

    blockers: list[str] = []
    warnings: list[str] = []

    overlap_ok = bool(overlap.get("independentSetZeroOverlapOk"))
    if not overlap_ok:
        blockers.append("overlap-check.json does not confirm zero overlap")

    holdout = audit_coverage(independent_rows, audit, preview_dir)
    if holdout["missingFromAudit"]:
        blockers.append(f"independent audit is missing {len(holdout['missingFromAudit'])} photoIds")
    if holdout["unresolvedPhotoIds"]:
        blockers.append(f"holdout has {len(holdout['unresolvedPhotoIds'])} unresolved preview rows")
    if holdout["explicitAuditPathUnverifiedCount"]:
        warnings.append(
            f"{holdout['explicitAuditPathUnverifiedCount']} holdout rows rely on explicit non-placeholder paths that cannot be verified locally"
        )

    patch = run_patch_and_merge(
        baseline_teacher=baseline_teacher,
        shortlist=shortlist_path,
        holdout_ids=holdout_ids_path,
    )
    if not patch.get("buildOk"):
        blockers.append("teacher patch build failed during preflight")
    elif int(patch.get("patchSummary", {}).get("patchedRows", 0)) <= 0:
        blockers.append("teacher patch would contain 0 rows; human shortlist confirmation is still incomplete")
    elif not patch.get("mergeOk"):
        blockers.append("teacher patch merge failed during preflight")

    payload = {
        "schemaVersion": "framecull-false-face-v13-phase3-preflight-v1",
        "modeLabel": args.mode_label,
        "inputs": {
            "baselineTeacher": str(baseline_teacher),
            "confirmedShortlist": str(shortlist_path),
            "holdoutIds": str(holdout_ids_path),
            "independentSet": str(independent_set_path),
            "independentAudit": str(independent_audit_path),
            "overlapCheck": str(overlap_check_path),
            "previewDir": str(preview_dir),
        },
        "overlap": {
            "ok": overlap_ok,
            "count": overlap.get("independentSetOverlapCount"),
            "teacherRecordCount": overlap.get("teacherRecordCount"),
        },
        "independentSet": independent_set_summary(independent_rows),
        "shortlist": shortlist_summary(shortlist_rows),
        "holdoutAuditCoverage": holdout,
        "patchPreflight": patch,
        "warnings": warnings,
        "blockers": blockers,
        "status": "ok" if not blockers else ("blocked_on_human_review" if any("0 rows" in item for item in blockers) and len(blockers) == 1 else "fail"),
    }

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": payload["status"], "outputJson": str(output_json)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
