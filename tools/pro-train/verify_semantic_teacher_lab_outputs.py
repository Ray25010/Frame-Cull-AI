#!/usr/bin/env python
"""Verify Semantic Teacher Lab v1 deliverables against the task spec."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


FINAL_REQUIRED_FILES = [
    "summary.md",
    "teacher-quality-report.md",
    "teacher-license-clearance.md",
    "metrics-by-ratio.csv",
    "metrics-by-scene.csv",
    "false-negatives-by-ratio.csv",
    "duplicate-pollution-by-ratio.csv",
    "false-face-samples.csv",
    "grounded-vs-flat-ablation.md",
    "pro-infer-latency.csv",
    "eval-run-meta.json",
    "selected-config-by-ratio.json",
    "selected-model-manifest.json",
    "production-recommendation.md",
]

EXPORT_REQUIRED_FILES = [
    "model.onnx",
    "model.int8.onnx",
    "manifest.json",
    "manifest.int8.json",
    "export-report.json",
    "training-report.json",
    "quant-compare.json",
    "teacher-schema.json",
    "selected-model-manifest.json",
]

FLAT_COMPARE_REQUIRED_FILES = [
    "summary.md",
    "metrics-by-ratio.csv",
    "metrics-by-scene.csv",
    "false-face-samples.csv",
    "pro-infer-latency.csv",
    "eval-run-meta.json",
    "selected-model-manifest.json",
]

PHASE0_REQUIRED_FILES = [
    "data-audit.json",
    "data-audit.md",
    "all-images.json",
    "smoke-list.json",
]

FEATURE_REQUIRED_FILES = [
    "teacher-feature-summary.json",
    "teacher-camera.npz",
    "teacher-audit3groups.npz",
]

EXPECTED_RATIOS = {0.38, 0.45, 0.50, 0.60}
EXPECTED_HEADS = {
    "aesthetic",
    "scene",
    "persona",
    "semantic_keep",
    "face_validity",
    "composition",
    "moment",
    "lighting",
    "false_face_risk",
}
FORBIDDEN_HEADS = {
    "storytelling",
    "storytelling_score",
    "storytellingScore",
    "empty_or_filler",
    "empty_or_filler_score",
    "emptyOrFiller",
    "technical_visible_issue",
    "technical_visible_issue_score",
    "technicalVisibleIssue",
    "scenic_value",
    "scenic_value_score",
    "scenicValue",
}
EXPECTED_QA_ONLY_FIELDS = {
    "storytellingScore",
    "emptyOrFillerScore",
    "technicalVisibleIssueScore",
    "scenicValueScore",
}
PLACEHOLDER_MARKERS = (
    "Missing Upstream Report",
    "placeholder until the flat-scalar arm is run",
    "not supplied in this run",
)


@dataclass
class Check:
    name: str
    status: str
    detail: str


def check_file(path: Path, *, allow_placeholder: bool = False) -> Check:
    if not path.exists():
        return Check(path.name, "fail", f"missing: {path}")
    if path.is_file() and path.stat().st_size <= 0:
        return Check(path.name, "fail", f"empty: {path}")
    if path.suffix.lower() in {".md", ".txt", ".json", ".csv"}:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:  # pragma: no cover - defensive
            return Check(path.name, "fail", f"read failed: {path}: {exc}")
        if not allow_placeholder:
            for marker in PLACEHOLDER_MARKERS:
                if marker in text:
                    return Check(path.name, "fail", f"placeholder content detected in {path}")
    return Check(path.name, "pass", f"ok: {path}")


def check_dir(path: Path) -> Check:
    if not path.exists():
        return Check(path.name, "fail", f"missing directory: {path}")
    if not path.is_dir():
        return Check(path.name, "fail", f"expected directory: {path}")
    return Check(path.name, "pass", f"ok: {path}")


def count_teacher_items(phase0_path: Path) -> int:
    items = json.loads(phase0_path.read_text(encoding="utf-8"))
    return sum(1 for item in items if item.get("teacherImagePath"))


def count_nonempty_lines(path: Path) -> int:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        return sum(1 for line in handle if line.strip())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_ratio_values(path: Path) -> set[float]:
    values: set[float] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            for key in ("ratio", "pick_ratio", "target_ratio"):
                value = row.get(key)
                if value is None or value == "":
                    continue
                try:
                    values.add(round(float(value), 2))
                    break
                except ValueError:
                    continue
    return values


def verify_phase0_data_audit(path: Path) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check("phase0-data-audit", "fail", f"invalid json: {exc}")]
    gate_status = str(payload.get("gateStatus") or "")
    if gate_status != "PASS":
        checks.append(Check("phase0-data-audit-gate", "fail", f"gateStatus must be PASS, got {gate_status!r}"))
    else:
        checks.append(Check("phase0-data-audit-gate", "pass", "gateStatus PASS"))
    if bool(payload.get("allowPreviewTeacherInput")):
        checks.append(Check("phase0-data-audit-preview-fallback", "fail", "preview teacher fallback must be disabled for full run"))
    else:
        checks.append(Check("phase0-data-audit-preview-fallback", "pass", "preview teacher fallback disabled"))
    teacher_min_long_edge = int(payload.get("teacherMinLongEdge") or 0)
    if teacher_min_long_edge < 768:
        checks.append(Check("phase0-data-audit-min-edge", "fail", f"teacherMinLongEdge must be >=768, got {teacher_min_long_edge}"))
    else:
        checks.append(Check("phase0-data-audit-min-edge", "pass", f"teacherMinLongEdge={teacher_min_long_edge}"))
    datasets = {str(item.get("dataset")): item for item in payload.get("datasets", []) if isinstance(item, dict)}
    for dataset, threshold in (("audit3groups", 3), ("camera", 1)):
        item = datasets.get(dataset)
        if not item:
            checks.append(Check(f"phase0-{dataset}", "fail", f"missing dataset summary for {dataset}"))
            continue
        if int(item.get("positiveThreshold") or -1) != threshold:
            checks.append(Check(f"phase0-{dataset}-threshold", "fail", f"{dataset} positiveThreshold expected {threshold}, got {item.get('positiveThreshold')}"))
        else:
            checks.append(Check(f"phase0-{dataset}-threshold", "pass", f"{dataset} threshold ok: {threshold}"))
    total_records = int(payload.get("totalRecords") or 0)
    teacher_ready = int(payload.get("teacherReadyRecords") or 0)
    if total_records <= 0 or teacher_ready != total_records:
        checks.append(Check("phase0-teacher-ready", "fail", f"teacherReadyRecords must equal totalRecords and be >0, got {teacher_ready}/{total_records}"))
    else:
        checks.append(Check("phase0-teacher-ready", "pass", f"teacherReadyRecords ok: {teacher_ready}/{total_records}"))
    return checks


def verify_phase0_all_images(path: Path) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check("phase0-all-images", "fail", f"invalid json: {exc}")]
    if not isinstance(payload, list) or not payload:
        return checks + [Check("phase0-all-images", "fail", "all-images.json must be a non-empty list")]
    preview_fallback = 0
    missing_teacher = 0
    shared_highres = 0
    preview_like_same_path = 0
    for row in payload:
        teacher_path = row.get("teacherImagePath")
        preview_path = row.get("studentPreviewPath")
        teacher_long_edge = int(row.get("teacherImageLongEdge") or 0)
        teacher_min_long_edge = int(row.get("teacherMinLongEdge") or 0)
        if not teacher_path:
            missing_teacher += 1
        if bool(row.get("teacherImageIsPreviewFallback")):
            preview_fallback += 1
        if teacher_path and preview_path and Path(str(teacher_path)) == Path(str(preview_path)):
            if teacher_long_edge >= max(768, teacher_min_long_edge):
                shared_highres += 1
            else:
                preview_like_same_path += 1
    if missing_teacher or preview_fallback or preview_like_same_path:
        checks.append(Check(
            "phase0-all-images-highres",
            "fail",
            "teacher image must be high-res for every row; "
            f"missing={missing_teacher}, previewFallback={preview_fallback}, "
            f"samePathTooSmall={preview_like_same_path}, sharedHighRes={shared_highres}",
        ))
    else:
        detail = f"all {len(payload)} rows use high-res teacher images"
        if shared_highres:
            detail += f"; sharedHighResSamePath={shared_highres}"
        checks.append(Check("phase0-all-images-highres", "pass", detail))
    return checks


def verify_teacher_quality_report(path: Path, *, expected_flat_scalar: bool) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check(path.name, "fail", f"invalid json: {exc}")]
    if bool(payload.get("flatScalar")) != expected_flat_scalar:
        checks.append(Check(f"{path.parent.name}-flat-scalar", "fail", f"expected flatScalar={expected_flat_scalar}, got {payload.get('flatScalar')}"))
    else:
        checks.append(Check(f"{path.parent.name}-flat-scalar", "pass", f"flatScalar ok: {expected_flat_scalar}"))
    validation = payload.get("validation") or {}
    if not bool(validation.get("passed")):
        checks.append(Check(f"{path.parent.name}-schema-validation", "fail", f"schema validation failed: {validation}"))
    else:
        checks.append(Check(f"{path.parent.name}-schema-validation", "pass", "schema validation passed"))
    if not expected_flat_scalar:
        if float(payload.get("traceCoverage") or 0.0) <= 0.0:
            checks.append(Check(f"{path.parent.name}-trace-coverage", "fail", "grounded teacher traceCoverage must be > 0"))
        else:
            checks.append(Check(f"{path.parent.name}-trace-coverage", "pass", f"traceCoverage={payload.get('traceCoverage')}"))
        if int(payload.get("humanFaceMissingVerdicts") or 0) != 0:
            checks.append(Check(f"{path.parent.name}-face-verdict-grounding", "fail", f"humanFaceMissingVerdicts must be 0, got {payload.get('humanFaceMissingVerdicts')}"))
        else:
            checks.append(Check(f"{path.parent.name}-face-verdict-grounding", "pass", "humanFaceMissingVerdicts=0"))
    return checks


def verify_teacher_feature_summary(path: Path) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check("teacher-feature-summary", "fail", f"invalid json: {exc}")]
    if not bool(payload.get("dinoEnabled")):
        checks.append(Check("teacher-feature-summary-dino", "fail", "dinoEnabled must be true"))
    else:
        checks.append(Check("teacher-feature-summary-dino", "pass", "dinoEnabled=true"))
    if bool(payload.get("fake")):
        checks.append(Check("teacher-feature-summary-fake", "fail", "fake teacher features must not be used in full run"))
    else:
        checks.append(Check("teacher-feature-summary-fake", "pass", "teacher features are real"))
    reports = {str(item.get("dataset")): item for item in payload.get("reports", []) if isinstance(item, dict)}
    for dataset in ("camera", "audit3groups"):
        item = reports.get(dataset)
        if not item:
            checks.append(Check(f"teacher-feature-summary-{dataset}", "fail", f"missing report for {dataset}"))
            continue
        clip_shape = list(item.get("clipShape") or [])
        dino_shape = list(item.get("dinoShape") or [])
        if len(clip_shape) != 2 or clip_shape[1] != 512:
            checks.append(Check(f"teacher-feature-summary-{dataset}-clip", "fail", f"{dataset} clipShape must end with 512, got {clip_shape}"))
        else:
            checks.append(Check(f"teacher-feature-summary-{dataset}-clip", "pass", f"{dataset} clipShape ok: {clip_shape}"))
        if len(dino_shape) != 2 or dino_shape[1] != 768:
            checks.append(Check(f"teacher-feature-summary-{dataset}-dino", "fail", f"{dataset} dinoShape must end with 768, got {dino_shape}"))
        else:
            checks.append(Check(f"teacher-feature-summary-{dataset}-dino", "pass", f"{dataset} dinoShape ok: {dino_shape}"))
    return checks


def verify_teacher_npz(path: Path, *, dataset: str) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = np.load(path, allow_pickle=True)
    except Exception as exc:
        return checks + [Check(f"{dataset}-teacher-npz", "fail", f"npz load failed: {exc}")]
    required = {"stems", "musiq_tech", "musiq_aes", "clip", "dino"}
    missing = sorted(required - set(payload.files))
    if missing:
        checks.append(Check(f"{dataset}-teacher-npz-keys", "fail", f"missing keys: {missing}"))
        return checks
    stems = payload["stems"]
    tech = payload["musiq_tech"]
    aes = payload["musiq_aes"]
    clip = payload["clip"]
    dino = payload["dino"]
    count = int(stems.shape[0])
    shape_ok = (
        count > 0
        and tech.shape == (count,)
        and aes.shape == (count,)
        and clip.shape == (count, 512)
        and dino.shape == (count, 768)
    )
    if not shape_ok:
        checks.append(Check(
            f"{dataset}-teacher-npz-shapes",
            "fail",
            f"expected stems={count}, tech/aes=({count},), clip=({count},512), dino=({count},768); got tech={tech.shape}, aes={aes.shape}, clip={clip.shape}, dino={dino.shape}",
        ))
    else:
        checks.append(Check(f"{dataset}-teacher-npz-shapes", "pass", f"npz shapes ok for {dataset}: count={count}"))
    return checks


def verify_manifest(path: Path, *, expected_flat_scalar: bool | None = None) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check("selected-model-manifest.json", "fail", f"invalid json: {exc}")]
    heads = {str(head.get("name")) for head in payload.get("heads", [])}
    missing_heads = sorted(EXPECTED_HEADS - heads)
    if missing_heads:
        checks.append(Check("selected-model-manifest-heads", "fail", f"missing heads: {missing_heads}"))
    else:
        checks.append(Check("selected-model-manifest-heads", "pass", f"heads ok: {sorted(heads)}"))
    forbidden_heads = sorted(heads & FORBIDDEN_HEADS)
    if forbidden_heads:
        checks.append(Check("selected-model-manifest-forbidden-heads", "fail", f"qa-only heads leaked into manifest: {forbidden_heads}"))
    else:
        checks.append(Check("selected-model-manifest-forbidden-heads", "pass", "no qa-only heads leaked"))
    lab_notes = payload.get("labNotes") or {}
    if int(lab_notes.get("dinoDim") or 0) != 768:
        checks.append(Check("selected-model-manifest-dino", "fail", f"dinoDim must be 768, got {lab_notes.get('dinoDim')}"))
    else:
        checks.append(Check("selected-model-manifest-dino", "pass", "dinoDim=768"))
    qa_only = set(lab_notes.get("qaOnlyFieldsNotExported") or [])
    if qa_only != EXPECTED_QA_ONLY_FIELDS:
        checks.append(Check("selected-model-manifest-qa-only", "fail", f"qaOnlyFieldsNotExported mismatch: {sorted(qa_only)}"))
    else:
        checks.append(Check("selected-model-manifest-qa-only", "pass", f"qaOnlyFieldsNotExported ok: {sorted(qa_only)}"))
    if expected_flat_scalar is not None:
        actual_flat = bool(lab_notes.get("teacherFlatScalar"))
        if actual_flat != expected_flat_scalar:
            checks.append(Check("selected-model-manifest-flat-scalar", "fail", f"expected teacherFlatScalar={expected_flat_scalar}, got {actual_flat}"))
        else:
            checks.append(Check("selected-model-manifest-flat-scalar", "pass", f"teacherFlatScalar ok: {actual_flat}"))
    persona = lab_notes.get("personaHead") or {}
    label_policy = persona.get("labelPolicy") or {}
    camera_threshold = ((label_policy.get("camera") or {}).get("positive_threshold"))
    audit_threshold = ((label_policy.get("audit3groups") or {}).get("positive_threshold"))
    if camera_threshold != 1 or audit_threshold != 3:
        checks.append(Check("selected-model-manifest-label-policy", "fail", f"persona label policy thresholds must be camera=1 audit3groups=3, got camera={camera_threshold}, audit3groups={audit_threshold}"))
    else:
        checks.append(Check("selected-model-manifest-label-policy", "pass", "persona label policy thresholds ok"))
    return checks


def verify_ratios(path: Path, label: str) -> Check:
    file_check = check_file(path)
    if file_check.status == "fail":
        return file_check
    ratios = parse_ratio_values(path)
    missing = sorted(EXPECTED_RATIOS - ratios)
    if missing:
        return Check(label, "fail", f"missing ratio rows {missing} in {path}")
    return Check(label, "pass", f"ratio rows ok: {sorted(ratios)}")


def verify_teacher_jsonl(path: Path, expected: int, label: str) -> Check:
    file_check = check_file(path)
    if file_check.status == "fail":
        return file_check
    actual = count_nonempty_lines(path)
    if actual != expected:
        return Check(label, "fail", f"expected {expected} rows, got {actual}: {path}")
    return Check(label, "pass", f"row count ok: {actual}")


def verify_ablation(path: Path) -> Check:
    file_check = check_file(path)
    if file_check.status == "fail":
        return file_check
    text = path.read_text(encoding="utf-8", errors="replace")
    if "Compare `metrics-by-ratio.csv`" in text and "placeholder" in text.lower():
        return Check("grounded-vs-flat-ablation.md", "fail", f"placeholder ablation still present: {path}")
    if "Flat-scalar output: not supplied in this run." in text:
        return Check("grounded-vs-flat-ablation.md", "fail", f"flat output not wired into ablation: {path}")
    return Check("grounded-vs-flat-ablation.md", "pass", f"ablation looks populated: {path}")


def verify_training_report_lineage(
    path: Path,
    *,
    teacher_path: Path,
    expected_count: int | None,
    expected_flat_scalar: bool,
    label: str,
) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check(f"{label}-training-report-json", "fail", f"invalid json: {exc}")]
    if not teacher_path.exists():
        checks.append(Check(f"{label}-training-report-lineage", "fail", f"teacher jsonl missing: {teacher_path}"))
        return checks
    expected_sha = sha256_file(teacher_path)
    actual_sha = str(payload.get("semanticTeacherSha256") or "")
    if actual_sha != expected_sha:
        checks.append(Check(
            f"{label}-training-report-lineage",
            "fail",
            f"semanticTeacherSha256 mismatch: expected {expected_sha}, got {actual_sha or 'missing'}",
        ))
    else:
        checks.append(Check(f"{label}-training-report-lineage", "pass", "semanticTeacherSha256 matches current teacher jsonl"))
    if expected_count is not None:
        actual_count = int(payload.get("semanticTeacherRecordCount") or 0)
        if actual_count != expected_count:
            checks.append(Check(
                f"{label}-training-report-count",
                "fail",
                f"semanticTeacherRecordCount must be {expected_count}, got {actual_count}",
            ))
        else:
            checks.append(Check(f"{label}-training-report-count", "pass", f"semanticTeacherRecordCount={actual_count}"))
    actual_flat = bool(payload.get("teacherFlatScalar"))
    if actual_flat != expected_flat_scalar:
        checks.append(Check(
            f"{label}-training-report-flat-scalar",
            "fail",
            f"teacherFlatScalar must be {expected_flat_scalar}, got {actual_flat}",
        ))
    else:
        checks.append(Check(f"{label}-training-report-flat-scalar", "pass", f"teacherFlatScalar={actual_flat}"))
    return checks


def verify_eval_run_meta(
    path: Path,
    *,
    manifest_path: Path,
    teacher_path: Path,
    phase0_path: Path,
    expected_count: int | None,
    expected_flat_scalar: bool,
    label: str,
) -> list[Check]:
    checks: list[Check] = [check_file(path)]
    if checks[-1].status == "fail":
        return checks
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return checks + [Check(f"{label}-eval-run-meta-json", "fail", f"invalid json: {exc}")]
    if not manifest_path.exists():
        checks.append(Check(f"{label}-eval-run-meta-manifest", "fail", f"manifest missing: {manifest_path}"))
    else:
        expected_manifest_sha = sha256_file(manifest_path)
        actual_manifest_sha = str(payload.get("manifestSha256") or "")
        if actual_manifest_sha != expected_manifest_sha:
            checks.append(Check(
                f"{label}-eval-run-meta-manifest",
                "fail",
                f"manifestSha256 mismatch: expected {expected_manifest_sha}, got {actual_manifest_sha or 'missing'}",
            ))
        else:
            checks.append(Check(f"{label}-eval-run-meta-manifest", "pass", "manifestSha256 matches current export manifest"))
    if not teacher_path.exists():
        checks.append(Check(f"{label}-eval-run-meta-teacher", "fail", f"teacher jsonl missing: {teacher_path}"))
    else:
        expected_teacher_sha = sha256_file(teacher_path)
        actual_teacher_sha = str(payload.get("semanticTeacherSha256") or "")
        if actual_teacher_sha != expected_teacher_sha:
            checks.append(Check(
                f"{label}-eval-run-meta-teacher",
                "fail",
                f"semanticTeacherSha256 mismatch: expected {expected_teacher_sha}, got {actual_teacher_sha or 'missing'}",
            ))
        else:
            checks.append(Check(f"{label}-eval-run-meta-teacher", "pass", "semanticTeacherSha256 matches current teacher jsonl"))
    if phase0_path.exists():
        expected_phase0_sha = sha256_file(phase0_path)
        actual_phase0_sha = str(payload.get("phase0AllImagesSha256") or "")
        if actual_phase0_sha != expected_phase0_sha:
            checks.append(Check(
                f"{label}-eval-run-meta-phase0",
                "fail",
                f"phase0AllImagesSha256 mismatch: expected {expected_phase0_sha}, got {actual_phase0_sha or 'missing'}",
            ))
        else:
            checks.append(Check(f"{label}-eval-run-meta-phase0", "pass", "phase0AllImagesSha256 matches current phase0"))
    else:
        checks.append(Check(f"{label}-eval-run-meta-phase0", "fail", f"phase0 missing: {phase0_path}"))
    if expected_count is not None:
        actual_count = int(payload.get("semanticTeacherRecordCount") or 0)
        if actual_count != expected_count:
            checks.append(Check(
                f"{label}-eval-run-meta-count",
                "fail",
                f"semanticTeacherRecordCount must be {expected_count}, got {actual_count}",
            ))
        else:
            checks.append(Check(f"{label}-eval-run-meta-count", "pass", f"semanticTeacherRecordCount={actual_count}"))
        actual_phase0_count = int(payload.get("phase0TeacherItemCount") or 0)
        if actual_phase0_count != expected_count:
            checks.append(Check(
                f"{label}-eval-run-meta-phase0-count",
                "fail",
                f"phase0TeacherItemCount must be {expected_count}, got {actual_phase0_count}",
            ))
        else:
            checks.append(Check(f"{label}-eval-run-meta-phase0-count", "pass", f"phase0TeacherItemCount={actual_phase0_count}"))
    actual_flat = bool(payload.get("teacherFlatScalar"))
    if actual_flat != expected_flat_scalar:
        checks.append(Check(
            f"{label}-eval-run-meta-flat-scalar",
            "fail",
            f"teacherFlatScalar must be {expected_flat_scalar}, got {actual_flat}",
        ))
    else:
        checks.append(Check(f"{label}-eval-run-meta-flat-scalar", "pass", f"teacherFlatScalar={actual_flat}"))
    result_count = int(payload.get("resultCount") or 0)
    if result_count <= 0:
        checks.append(Check(f"{label}-eval-run-meta-results", "fail", f"resultCount must be >0, got {result_count}"))
    else:
        checks.append(Check(f"{label}-eval-run-meta-results", "pass", f"resultCount={result_count}"))
    return checks


def render_markdown(checks: list[Check]) -> str:
    total = len(checks)
    failed = sum(1 for check in checks if check.status == "fail")
    warned = sum(1 for check in checks if check.status == "warn")
    lines = [
        "# Semantic Teacher Lab Output Audit",
        "",
        f"- Total checks: `{total}`",
        f"- Failed: `{failed}`",
        f"- Warned: `{warned}`",
        "",
        "| Check | Status | Detail |",
        "|---|---|---|",
    ]
    for check in checks:
        lines.append(f"| `{check.name}` | `{check.status}` | {check.detail} |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", default="/data/FrameCullModelLab")
    parser.add_argument("--output-json")
    parser.add_argument("--output-md")
    args = parser.parse_args()

    lab = Path(args.lab)
    phase0_dir = lab / "outputs" / "semantic-teacher-lab" / "phase0"
    phase0 = phase0_dir / "all-images.json"
    phase0_data_audit = phase0_dir / "data-audit.json"
    phase0_data_audit_md = phase0_dir / "data-audit.md"
    phase0_smoke_list = phase0_dir / "smoke-list.json"
    grounded_teacher = lab / "features" / "semantic-teacher" / "semantic-teacher-v1.jsonl"
    grounded_teacher_summary = lab / "features" / "semantic-teacher" / "semantic-teacher-v1.summary.json"
    teacher_failures = lab / "features" / "semantic-teacher" / "teacher-failures.csv"
    teacher_qa_samples_dir = lab / "features" / "semantic-teacher" / "teacher-qa-samples"
    grounded_teacher_qa_samples = teacher_qa_samples_dir / "grounded-teacher-qa-samples.csv"
    flat_teacher = lab / "features" / "semantic-teacher" / "semantic-teacher-v1-flat.jsonl"
    flat_teacher_summary = lab / "features" / "semantic-teacher" / "semantic-teacher-v1-flat.summary.json"
    flat_teacher_qa_samples = teacher_qa_samples_dir / "flat-teacher-qa-samples.csv"
    feature_dir = lab / "features" / "teacher"
    teacher_feature_summary = feature_dir / "teacher-feature-summary.json"
    teacher_camera_npz = feature_dir / "teacher-camera.npz"
    teacher_audit_npz = feature_dir / "teacher-audit3groups.npz"
    grounded_eval = lab / "outputs" / "semantic-teacher-lab" / "eval-full" / "bench-grounded"
    flat_eval = lab / "outputs" / "semantic-teacher-lab" / "eval-full" / "bench-flat"
    grounded_export = lab / "outputs" / "pro-models" / "semantic_student_v2_grounded_convnext"
    flat_export = lab / "outputs" / "pro-models" / "semantic_student_v2_flat_convnext"
    teacher_license = lab / "outputs" / "semantic-teacher-lab" / "teacher-license-clearance.md"
    grounded_qa = lab / "outputs" / "semantic-teacher-lab" / "teacher-qa-grounded-full" / "teacher-quality-report.md"
    flat_qa = lab / "outputs" / "semantic-teacher-lab" / "teacher-qa-flat-full" / "teacher-quality-report.md"
    grounded_qa_json = lab / "outputs" / "semantic-teacher-lab" / "teacher-qa-grounded-full" / "teacher-quality-report.json"
    flat_qa_json = lab / "outputs" / "semantic-teacher-lab" / "teacher-qa-flat-full" / "teacher-quality-report.json"

    checks: list[Check] = []

    for extra in (phase0_data_audit_md, phase0_smoke_list):
        checks.append(check_file(extra))
    checks.extend(verify_phase0_data_audit(phase0_data_audit))
    phase0_check = check_file(phase0)
    checks.append(phase0_check)
    checks.extend(verify_phase0_all_images(phase0))
    if phase0_check.status == "fail":
        expected_count = None
    else:
        expected_count = count_teacher_items(phase0)
        checks.append(Check("phase0-expected-count", "pass", f"teacher items expected: {expected_count}"))

    if expected_count is not None:
        checks.append(verify_teacher_jsonl(grounded_teacher, expected_count, "grounded-teacher-jsonl"))
        checks.append(verify_teacher_jsonl(flat_teacher, expected_count, "flat-teacher-jsonl"))
    else:
        checks.append(Check("grounded-teacher-jsonl", "fail", "phase0 unavailable"))
        checks.append(Check("flat-teacher-jsonl", "fail", "phase0 unavailable"))
    checks.append(check_file(grounded_teacher_summary))
    checks.append(check_file(flat_teacher_summary))
    checks.append(check_file(teacher_failures))
    checks.append(check_dir(teacher_qa_samples_dir))
    checks.append(check_file(grounded_teacher_qa_samples))
    checks.append(check_file(flat_teacher_qa_samples))

    checks.append(check_file(teacher_license))
    checks.append(check_file(grounded_qa))
    checks.append(check_file(flat_qa))
    checks.extend(verify_teacher_quality_report(grounded_qa_json, expected_flat_scalar=False))
    checks.extend(verify_teacher_quality_report(flat_qa_json, expected_flat_scalar=True))
    checks.extend(verify_teacher_feature_summary(teacher_feature_summary))
    checks.extend(verify_teacher_npz(teacher_camera_npz, dataset="camera"))
    checks.extend(verify_teacher_npz(teacher_audit_npz, dataset="audit3groups"))

    for name in FINAL_REQUIRED_FILES:
        target = grounded_eval / name
        if name == "grounded-vs-flat-ablation.md":
            checks.append(verify_ablation(target))
        elif name == "eval-run-meta.json":
            checks.extend(verify_eval_run_meta(
                target,
                manifest_path=grounded_export / "manifest.int8.json",
                teacher_path=grounded_teacher,
                phase0_path=phase0,
                expected_count=expected_count,
                expected_flat_scalar=False,
                label="grounded",
            ))
        elif name == "selected-model-manifest.json":
            checks.extend(verify_manifest(target, expected_flat_scalar=False))
        elif name == "metrics-by-ratio.csv":
            checks.append(verify_ratios(target, "grounded-metrics-by-ratio"))
        else:
            checks.append(check_file(target))

    for name in FLAT_COMPARE_REQUIRED_FILES:
        target = flat_eval / name
        if name == "eval-run-meta.json":
            checks.extend(verify_eval_run_meta(
                target,
                manifest_path=flat_export / "manifest.int8.json",
                teacher_path=flat_teacher,
                phase0_path=phase0,
                expected_count=expected_count,
                expected_flat_scalar=True,
                label="flat",
            ))
        elif name == "selected-model-manifest.json":
            checks.extend(verify_manifest(target, expected_flat_scalar=True))
        elif name == "metrics-by-ratio.csv":
            checks.append(verify_ratios(target, "flat-metrics-by-ratio"))
        else:
            checks.append(check_file(target))

    for export_dir, label in ((grounded_export, "grounded"), (flat_export, "flat")):
        for name in EXPORT_REQUIRED_FILES:
            checks.append(check_file(export_dir / name))
        checks.extend(verify_manifest(export_dir / "selected-model-manifest.json", expected_flat_scalar=(label == "flat")))
        checks.extend(verify_training_report_lineage(
            export_dir / "training-report.json",
            teacher_path=grounded_teacher if label == "grounded" else flat_teacher,
            expected_count=expected_count,
            expected_flat_scalar=(label == "flat"),
            label=label,
        ))

    failed = [check for check in checks if check.status == "fail"]
    payload: dict[str, Any] = {
        "schema": "framecull-semantic-teacher-lab-output-audit-v1",
        "lab": str(lab),
        "totalChecks": len(checks),
        "failedChecks": len(failed),
        "checks": [check.__dict__ for check in checks],
        "ok": len(failed) == 0,
    }

    output_json = Path(args.output_json) if args.output_json else grounded_eval / "final-output-audit.json"
    output_md = Path(args.output_md) if args.output_md else grounded_eval / "final-output-audit.md"
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_md.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output_md.write_text(render_markdown(checks), encoding="utf-8")

    print(json.dumps({
        "ok": payload["ok"],
        "failedChecks": payload["failedChecks"],
        "outputJson": str(output_json),
        "outputMd": str(output_md),
    }, ensure_ascii=False))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
