#!/usr/bin/env python
"""Collect Semantic Teacher Lab logs/results for paper writing.

This script connects to the 5090 training server, snapshots the current
Semantic Teacher Lab outputs, downloads paper-friendly artifacts to a local
timestamped folder, and writes a manifest/README for later writing.

Defaults:
- collect logs, reports, CSV/JSON/Markdown, and sample images
- skip large binaries such as .pt, .onnx, .npz, and raw .jsonl teacher dumps
- tolerate in-progress runs and record missing/pending outputs in the manifest
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable

import _ssh


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


DEFAULT_LOCAL_ROOT = Path("output") / "paper-artifacts" / "semantic-teacher-lab"
DEFAULT_ALLOWED_SUFFIXES = {
    ".csv",
    ".json",
    ".log",
    ".md",
    ".mjs",
    ".png",
    ".ps1",
    ".py",
    ".sh",
    ".jpg",
    ".jpeg",
    ".txt",
    ".webp",
    ".yaml",
    ".yml",
}
OPTIONAL_SUFFIXES = {
    "jsonl": ".jsonl",
    "npz": ".npz",
    "onnx": ".onnx",
    "checkpoints": ".pt",
}
SKIP_NAME_PARTS = (".stale-", "__pycache__")


@dataclass(frozen=True)
class DirSpec:
    category: str
    remote_path: str
    recursive: bool = True


@dataclass(frozen=True)
class FileSpec:
    category: str
    remote_path: str


DIR_SPECS = [
    DirSpec("logs", "/data/FrameCullModelLab/logs"),
    DirSpec("phase0", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/phase0"),
    DirSpec("teacher_features", "/data/FrameCullModelLab/features/semantic-teacher"),
    DirSpec("teacher_features_npz", "/data/FrameCullModelLab/features/teacher"),
    DirSpec("teacher_schema", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/schema"),
    DirSpec("teacher_license_snapshots", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-license-snapshots"),
    DirSpec("teacher_qa_grounded", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-qa-grounded-full"),
    DirSpec("teacher_qa_flat", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-qa-flat-full"),
    DirSpec("eval_smoke", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-smoke"),
    DirSpec("student_grounded", "/data/FrameCullModelLab/outputs/semantic-student/grounded-convnext"),
    DirSpec("student_flat", "/data/FrameCullModelLab/outputs/semantic-student/flat-convnext"),
    DirSpec("persona_grounded", "/data/FrameCullModelLab/outputs/semantic-student/grounded-convnext-persona"),
    DirSpec("persona_flat", "/data/FrameCullModelLab/outputs/semantic-student/flat-convnext-persona"),
    DirSpec("semantic_student_smoke", "/data/FrameCullModelLab/outputs/semantic-student-smoke"),
    DirSpec("semantic_student_v2_smoke", "/data/FrameCullModelLab/outputs/semantic-student-v2"),
    DirSpec("distill", "/data/FrameCullModelLab/outputs/distill"),
    DirSpec("persona_baselines", "/data/FrameCullModelLab/outputs/persona"),
    DirSpec("export_grounded", "/data/FrameCullModelLab/outputs/pro-models/semantic_student_v2_grounded_convnext"),
    DirSpec("export_flat", "/data/FrameCullModelLab/outputs/pro-models/semantic_student_v2_flat_convnext"),
    DirSpec("pro_models_catalog", "/data/FrameCullModelLab/outputs/pro-models"),
    DirSpec("pro_models_smoke", "/data/FrameCullModelLab/outputs/pro-models-smoke"),
    DirSpec("pro_persona_eval", "/data/FrameCullModelLab/outputs/pro-persona-eval"),
    DirSpec("current_rules_recall", "/data/FrameCullModelLab/outputs/current-rules-recall"),
    DirSpec("eval_grounded", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded"),
    DirSpec("eval_flat", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-flat"),
]

RAW_VLM_DIR_SPECS = [
    DirSpec("teacher_raw_grounded", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/raw-vlm"),
    DirSpec("teacher_raw_flat", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/raw-vlm-flat"),
    DirSpec("teacher_raw_patched", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/raw-vlm-patched"),
]

FILE_SPECS = [
    FileSpec("teacher_license", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-license-clearance.md"),
    FileSpec("teacher_license", "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-license-clearance.json"),
    FileSpec("ratio_config", "/data/FrameCullModelLab/workspace/output/ai-bench/ratio-aware-ai-picks/selected-config-by-ratio.json"),
]

LOCAL_DIR_SPECS = [
    DirSpec("local_diagnosis", "output/semantic-false-face-diagnosis"),
    DirSpec("local_research", "research/framecull-pro-semantic-teacher-lab"),
]

LOCAL_FILE_SPECS = [
    FileSpec("local_goal", "output/fix-semantic-false-face-goal-prompt.txt"),
    FileSpec("local_docs", "docs/TASK_fix_semantic_false_face.md"),
    FileSpec("local_docs", "docs/GOAL_pro_semantic_teacher_lab.md"),
    FileSpec("local_docs", "docs/GOAL_pro_infer_layer.md"),
    FileSpec("local_docs", "docs/PRO_MODEL_ARCHITECTURE.md"),
    FileSpec("local_docs", "docs/PRO_SEMANTIC_PAPER_ARTIFACTS.md"),
    FileSpec("local_docs", "docs/PRO_SEMANTIC_TEACHER_LAB_RESEARCH_TASK.md"),
    FileSpec("local_scripts", "tools/pro-train/capture_semantic_paper_snapshot.ps1"),
    FileSpec("local_scripts", "tools/pro-train/run_semantic_teacher.py"),
    FileSpec("local_scripts", "tools/pro-train/semantic_teacher_schema.py"),
    FileSpec("local_scripts", "tools/pro-train/build_quality_teacher_features.py"),
    FileSpec("local_scripts", "tools/pro-train/diagnose_semantic_false_face.py"),
    FileSpec("local_scripts", "tools/pro-train/inspect_teacher_lineage.py"),
    FileSpec("local_scripts", "tools/pro-train/audit_semantic_teacher.py"),
    FileSpec("local_scripts", "tools/pro-train/prepare_semantic_teacher_images.py"),
    FileSpec("local_scripts", "tools/pro-train/repair_semantic_teacher_jsonl.py"),
    FileSpec("local_scripts", "tools/pro-train/sync_semantic_teacher_phase_outputs.py"),
    FileSpec("local_scripts", "tools/pro-train/teacher_license_clearance.py"),
    FileSpec("local_scripts", "tools/pro-train/train_distill_backbone.py"),
    FileSpec("local_scripts", "tools/pro-train/train_persona_head.py"),
    FileSpec("local_scripts", "tools/pro-train/train_semantic_student.py"),
    FileSpec("local_scripts", "tools/pro-train/compare_onnx_quant.py"),
    FileSpec("local_scripts", "tools/pro-train/export_pro_onnx.py"),
    FileSpec("local_scripts", "tools/pro-train/export_pro_semantic_onnx.py"),
    FileSpec("local_scripts", "tools/pro-train/run_pro_semantic_onnx_infer.py"),
    FileSpec("local_scripts", "tools/pro-train/run_grounded_export_eval_when_ready.sh"),
    FileSpec("local_scripts", "tools/pro-train/launch_full_distill.sh"),
    FileSpec("local_scripts", "tools/pro-train/launch_full_persona.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_full_distill.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_full_persona.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_semantic_teacher_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_semantic_student_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/launch_semantic_student_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_semantic_persona_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_semantic_export_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/run_semantic_eval_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/watch_semantic_teacher_pipeline_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/watch_semantic_student_pipeline_server.sh"),
    FileSpec("local_scripts", "tools/pro-train/verify_semantic_teacher_lab_outputs.py"),
    FileSpec("local_scripts", "tools/pro-train/collect_semantic_teacher_paper_artifacts.py"),
    FileSpec("local_scripts", "tools/pro-train/build_semantic_false_face_validation.py"),
    FileSpec("local_scripts", "tools/pro-train/_ssh.py"),
    FileSpec("local_scripts", "tools/ai-lab/bench-pro-persona.mjs"),
    FileSpec("local_scripts", "tools/ai-lab/build-pro-semantic-eval-audit.mjs"),
    FileSpec("local_scripts", "tools/ai-lab/bench-pro-semantic-student.mjs"),
    FileSpec("local_scripts", "tools/ai-lab/write-pro-semantic-ablation.mjs"),
]

REMOTE_STATUS_COMMANDS = {
    "semantic-teacher-status.txt": "cd /data/FrameCullModelLab/workspace && bash tools/pro-train/semantic_teacher_status_server.sh",
    "active-jobs.txt": (
        "ps -eo pid,ppid,stat,etime,cmd | "
        "grep -E 'train_semantic_student.py|train_persona_head.py|run_semantic_export_server.sh|"
        "run_semantic_eval_server.sh|export_pro_semantic_onnx.py|run_pro_semantic_onnx_infer.py|"
        "watch_semantic_student_pipeline_server' | grep -v grep"
    ),
    "gpu.txt": "nvidia-smi",
    "runtime-versions.txt": (
        "/home/hph/miniconda3/envs/train5090/bin/python -c "
        "\"import sys; print('python=' + sys.version.replace('\\n', ' ')); "
        "import torch; print('torch=' + torch.__version__); "
        "print('cuda=' + str(torch.version.cuda)); print('cuda_available=' + str(torch.cuda.is_available())); "
        "import onnxruntime as ort; print('onnxruntime=' + ort.__version__)\""
    ),
    "disk-usage.txt": (
        "df -h /data/FrameCullModelLab && echo && "
        "du -sh /data/FrameCullModelLab/logs /data/FrameCullModelLab/features /data/FrameCullModelLab/outputs 2>/dev/null"
    ),
    "workspace-head.txt": "cd /data/FrameCullModelLab/workspace && git rev-parse HEAD",
    "workspace-status.txt": "cd /data/FrameCullModelLab/workspace && git status --short",
}

LOCAL_STATUS_COMMANDS = {
    "local-workspace-head.txt": ["git", "rev-parse", "HEAD"],
    "local-workspace-status.txt": ["git", "status", "--short"],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lab", default="/data/FrameCullModelLab")
    parser.add_argument("--workspace", default="/data/FrameCullModelLab/workspace")
    parser.add_argument("--local-root", type=Path, default=DEFAULT_LOCAL_ROOT)
    parser.add_argument("--tag", default="")
    parser.add_argument("--include-jsonl", action="store_true")
    parser.add_argument("--include-npz", action="store_true")
    parser.add_argument("--include-models", action="store_true")
    parser.add_argument("--include-checkpoints", action="store_true")
    parser.add_argument("--include-raw-vlm", action="store_true")
    parser.add_argument("--zip", dest="zip_snapshot", action="store_true", default=True)
    parser.add_argument("--no-zip", dest="zip_snapshot", action="store_false")
    return parser.parse_args()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bash_wrap(command: str) -> str:
    return f"bash -lc {shlex.quote(command)}"


def exec_remote(client, command: str) -> dict[str, object]:
    stdin, stdout, stderr = client.exec_command(bash_wrap(command), timeout=None, get_pty=False)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return {
        "command": command,
        "exitCode": code,
        "stdout": out,
        "stderr": err,
    }


def exec_local(command: list[str], cwd: Path) -> dict[str, object]:
    completed = subprocess.run(
        command,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return {
        "command": " ".join(shlex.quote(part) for part in command),
        "exitCode": int(completed.returncode),
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def remote_exists(sftp, remote_path: str) -> bool:
    try:
        sftp.stat(remote_path)
        return True
    except OSError:
        return False


def is_dir_attr(attr) -> bool:
    return stat.S_ISDIR(attr.st_mode)


def is_file_attr(attr) -> bool:
    return stat.S_ISREG(attr.st_mode)


def should_skip_name(name: str) -> bool:
    return any(part in name for part in SKIP_NAME_PARTS)


def suffix_allowed(path: PurePosixPath, args: argparse.Namespace) -> bool:
    suffix = path.suffix.lower()
    if suffix in DEFAULT_ALLOWED_SUFFIXES:
        return True
    if args.include_jsonl and suffix == OPTIONAL_SUFFIXES["jsonl"]:
        return True
    if args.include_npz and suffix == OPTIONAL_SUFFIXES["npz"]:
        return True
    if args.include_models and suffix == OPTIONAL_SUFFIXES["onnx"]:
        return True
    if args.include_checkpoints and suffix == OPTIONAL_SUFFIXES["checkpoints"]:
        return True
    return False


def relative_remote_path(remote_path: str, lab_root: str) -> PurePosixPath:
    remote = PurePosixPath(remote_path)
    try:
        return remote.relative_to(PurePosixPath(lab_root))
    except ValueError:
        cleaned = [part for part in remote.parts if part not in ("/", "")]
        return PurePosixPath("_absolute").joinpath(*cleaned)


def relative_local_path(local_path: Path, repo_root: Path) -> Path:
    try:
        return local_path.resolve().relative_to(repo_root.resolve())
    except ValueError:
        return Path("_absolute").joinpath(*local_path.resolve().parts[1:])


def walk_remote_files(sftp, root: str, *, recursive: bool) -> list[str]:
    results: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            attrs = sorted(sftp.listdir_attr(current), key=lambda item: item.filename.lower())
        except OSError:
            continue
        for attr in attrs:
            name = attr.filename
            if should_skip_name(name):
                continue
            child = str(PurePosixPath(current) / name)
            if is_dir_attr(attr):
                if recursive:
                    stack.append(child)
                continue
            if is_file_attr(attr):
                results.append(child)
    return results


def walk_local_files(root: Path, *, recursive: bool) -> list[Path]:
    if not root.exists():
        return []
    iterator = root.rglob("*") if recursive else root.glob("*")
    results: list[Path] = []
    for child in iterator:
        if should_skip_name(child.name):
            continue
        if child.is_file():
            results.append(child)
    return sorted(results)


def download_one(
    *,
    sftp,
    remote_path: str,
    local_root: Path,
    lab_root: str,
    category: str,
) -> dict[str, object]:
    local_rel = Path("remote") / Path(*relative_remote_path(remote_path, lab_root).parts)
    local_path = local_root / local_rel
    local_path.parent.mkdir(parents=True, exist_ok=True)
    sftp.get(remote_path, str(local_path))
    st = sftp.stat(remote_path)
    return {
        "category": category,
        "sourceType": "remote",
        "status": "downloaded",
        "remotePath": remote_path,
        "localPath": str(local_path),
        "sizeBytes": int(st.st_size),
        "modifiedAtEpoch": int(st.st_mtime),
        "modifiedAtUtc": iso_z(datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)),
        "sha256": sha256_file(local_path),
    }


def copy_one_local(
    *,
    source_path: Path,
    local_root: Path,
    repo_root: Path,
    category: str,
) -> dict[str, object]:
    relative_source = relative_local_path(source_path, repo_root)
    local_rel = Path("workspace") / relative_source
    local_path = local_root / local_rel
    local_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, local_path)
    stat_result = source_path.stat()
    return {
        "category": category,
        "sourceType": "local",
        "status": "downloaded",
        "remotePath": "",
        "sourcePath": str(source_path),
        "localPath": str(local_path),
        "sizeBytes": int(stat_result.st_size),
        "modifiedAtEpoch": int(stat_result.st_mtime),
        "modifiedAtUtc": iso_z(datetime.fromtimestamp(stat_result.st_mtime, tz=timezone.utc)),
        "sha256": sha256_file(local_path),
    }


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_status_file(path: Path, payload: dict[str, object]) -> None:
    text = [
        f"$ {payload['command']}",
        "",
        str(payload.get("stdout") or ""),
    ]
    stderr = str(payload.get("stderr") or "").strip()
    if stderr:
        text.extend(["", "[stderr]", stderr])
    text.extend(["", f"[exit={payload['exitCode']}]"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(text).rstrip() + "\n", encoding="utf-8")


def write_index_csv(path: Path, items: Iterable[dict[str, object]]) -> None:
    rows = list(items)
    fields = [
        "sourceType",
        "category",
        "status",
        "sourcePath",
        "remotePath",
        "localPath",
        "sizeBytes",
        "modifiedAtUtc",
        "sha256",
        "note",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def read_json_if_exists(path: Path) -> object | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        try:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            return None


def read_csv_rows_if_exists(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            return list(csv.DictReader(handle))
    except Exception:
        return []


def to_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return None
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def relative_snapshot_path(base: Path, target: Path) -> str:
    try:
        return str(target.relative_to(base))
    except ValueError:
        return str(target)


def snapshot_remote_target(snapshot_dir: Path, lab_root: str, remote_path: str) -> Path:
    rel = Path("remote") / Path(*relative_remote_path(remote_path, lab_root).parts)
    return snapshot_dir / rel


def build_stage_summary(snapshot_dir: Path, lab_root: str) -> dict[str, object]:
    grounded_teacher_qa = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-qa-grounded-full/teacher-quality-report.json",
        )
    ) or {}
    flat_teacher_qa = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-qa-flat-full/teacher-quality-report.json",
        )
    ) or {}
    grounded_student = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-student/grounded-convnext/training-report.json",
        )
    ) or {}
    flat_student = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-student/flat-convnext/training-report.json",
        )
    ) or {}
    grounded_persona = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-student/grounded-convnext-persona/summary.json",
        )
    ) or {}
    flat_persona = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-student/flat-convnext-persona/summary.json",
        )
    ) or {}
    grounded_export = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/pro-models/semantic_student_v2_grounded_convnext/export-report.json",
        )
    ) or {}
    flat_export = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/pro-models/semantic_student_v2_flat_convnext/export-report.json",
        )
    ) or {}
    grounded_eval_meta = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded/eval-run-meta.json",
        )
    ) or {}
    flat_eval_meta = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-flat/eval-run-meta.json",
        )
    ) or {}
    grounded_selected = read_json_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded/selected-config-by-ratio.json",
        )
    ) or {}
    grounded_metrics_rows = read_csv_rows_if_exists(
        snapshot_remote_target(
            snapshot_dir,
            lab_root,
            "/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded/metrics-by-ratio.csv",
        )
    )

    selected_rows = [row for row in grounded_metrics_rows if to_bool(row.get("selected"))]
    if not selected_rows:
        selected_rows = grounded_metrics_rows

    return {
        "groundedTeacherQa": {
            "total": to_int(grounded_teacher_qa.get("total")),
            "uncertainCount": to_int(grounded_teacher_qa.get("uncertainCount")),
            "traceCoverage": to_float(grounded_teacher_qa.get("traceCoverage")),
            "faceVerdictCoverage": to_float(grounded_teacher_qa.get("faceVerdictCoverage")),
            "humanFaceMissingVerdicts": to_int(grounded_teacher_qa.get("humanFaceMissingVerdicts")),
        },
        "flatTeacherQa": {
            "total": to_int(flat_teacher_qa.get("total")),
            "uncertainCount": to_int(flat_teacher_qa.get("uncertainCount")),
            "traceCoverage": to_float(flat_teacher_qa.get("traceCoverage")),
            "faceVerdictCoverage": to_float(flat_teacher_qa.get("faceVerdictCoverage")),
            "humanFaceMissingVerdicts": to_int(flat_teacher_qa.get("humanFaceMissingVerdicts")),
        },
        "groundedStudent": {
            "backbone": grounded_student.get("backbone"),
            "teacherFlatScalar": grounded_student.get("teacherFlatScalar"),
            "totalItems": to_int(grounded_student.get("totalItems")),
            "bestScore": to_float(grounded_student.get("bestScore")),
            "sceneAccuracy": to_float(((grounded_student.get("bestMetrics") or {}).get("sceneAccuracy"))),
            "aestheticSrcc": to_float((((grounded_student.get("bestMetrics") or {}).get("aestheticCorr") or {}).get("srcc"))),
            "elapsedS": to_float(grounded_student.get("elapsedS")),
            "semanticTeacherRecordCount": to_int(grounded_student.get("semanticTeacherRecordCount")),
        },
        "flatStudent": {
            "backbone": flat_student.get("backbone"),
            "teacherFlatScalar": flat_student.get("teacherFlatScalar"),
            "totalItems": to_int(flat_student.get("totalItems")),
            "bestScore": to_float(flat_student.get("bestScore")),
            "sceneAccuracy": to_float(((flat_student.get("bestMetrics") or {}).get("sceneAccuracy"))),
            "aestheticSrcc": to_float((((flat_student.get("bestMetrics") or {}).get("aestheticCorr") or {}).get("srcc"))),
            "elapsedS": to_float(flat_student.get("elapsedS")),
            "semanticTeacherRecordCount": to_int(flat_student.get("semanticTeacherRecordCount")),
        },
        "groundedPersona": {
            "total": to_int(grounded_persona.get("total")),
            "positive": to_int(grounded_persona.get("positive")),
            "negative": to_int(grounded_persona.get("negative")),
            "ratingSrcc": to_float(grounded_persona.get("ratingSrcc")),
            "allAuc": to_float(((grounded_persona.get("allMetrics") or {}).get("auc"))),
            "allAp": to_float(((grounded_persona.get("allMetrics") or {}).get("ap"))),
            "elapsedS": to_float(grounded_persona.get("elapsedS")),
        },
        "flatPersona": {
            "total": to_int(flat_persona.get("total")),
            "positive": to_int(flat_persona.get("positive")),
            "negative": to_int(flat_persona.get("negative")),
            "ratingSrcc": to_float(flat_persona.get("ratingSrcc")),
            "allAuc": to_float(((flat_persona.get("allMetrics") or {}).get("auc"))),
            "allAp": to_float(((flat_persona.get("allMetrics") or {}).get("ap"))),
            "elapsedS": to_float(flat_persona.get("elapsedS")),
        },
        "groundedExport": {
            "studentSchema": ((grounded_export.get("student") or {}).get("schema")),
            "personaIncluded": bool((grounded_export.get("persona") or {}).get("path")),
            "fp32Bytes": to_int(((grounded_export.get("fp32") or {}).get("bytes"))),
            "int8Bytes": to_int(((grounded_export.get("int8") or {}).get("bytes"))),
        },
        "flatExport": {
            "studentSchema": ((flat_export.get("student") or {}).get("schema")),
            "personaIncluded": bool((flat_export.get("persona") or {}).get("path")),
            "fp32Bytes": to_int(((flat_export.get("fp32") or {}).get("bytes"))),
            "int8Bytes": to_int(((flat_export.get("int8") or {}).get("bytes"))),
        },
        "groundedEval": {
            "activeEp": grounded_eval_meta.get("activeEp"),
            "batchSize": to_int(grounded_eval_meta.get("batchSize")),
            "resultCount": to_int(grounded_eval_meta.get("resultCount")),
            "teacherFlatScalar": grounded_eval_meta.get("teacherFlatScalar"),
            "profiles": [
                {
                    "ratio": to_float(row.get("ratio")),
                    "name": row.get("name"),
                    "family": row.get("family"),
                    "recall": to_float(row.get("recall")),
                    "negativePickRate": to_float(row.get("negativePickRate")),
                    "selectedSimilarAdjacentPairs": to_int(row.get("selectedSimilarAdjacentPairs")),
                }
                for row in selected_rows
            ],
            "recommendation": ((grounded_selected.get("recommendation") or {}).get("profiles")),
        },
        "flatEval": {
            "activeEp": flat_eval_meta.get("activeEp"),
            "batchSize": to_int(flat_eval_meta.get("batchSize")),
            "resultCount": to_int(flat_eval_meta.get("resultCount")),
            "teacherFlatScalar": flat_eval_meta.get("teacherFlatScalar"),
        },
    }


def build_paper_summary_markdown(
    *,
    snapshot_dir: Path,
    summary: dict[str, object],
) -> str:
    grounded_teacher = summary.get("groundedTeacherQa") or {}
    flat_teacher = summary.get("flatTeacherQa") or {}
    grounded_student = summary.get("groundedStudent") or {}
    grounded_persona = summary.get("groundedPersona") or {}
    grounded_export = summary.get("groundedExport") or {}
    grounded_eval = summary.get("groundedEval") or {}
    profiles = grounded_eval.get("profiles") or []

    lines = [
        "# Paper Quick Notes",
        "",
        "## Why This Snapshot Matters",
        "",
        "- This file extracts the paper-facing metrics from the full snapshot so later writing does not require manually opening dozens of JSON files.",
        "- The raw logs, reports, CSV tables, and copied scripts still remain in the same snapshot directory for deeper traceability.",
        "",
        "## Teacher QA",
        "",
        f"- grounded total: `{grounded_teacher.get('total')}`",
        f"- grounded uncertainCount: `{grounded_teacher.get('uncertainCount')}`",
        f"- grounded faceVerdictCoverage: `{grounded_teacher.get('faceVerdictCoverage')}`",
        f"- flat total: `{flat_teacher.get('total')}`",
        f"- flat uncertainCount: `{flat_teacher.get('uncertainCount')}`",
        f"- flat faceVerdictCoverage: `{flat_teacher.get('faceVerdictCoverage')}`",
        "",
        "## Grounded Student",
        "",
        f"- backbone: `{grounded_student.get('backbone')}`",
        f"- teacher records: `{grounded_student.get('semanticTeacherRecordCount')}`",
        f"- bestScore: `{grounded_student.get('bestScore')}`",
        f"- sceneAccuracy: `{grounded_student.get('sceneAccuracy')}`",
        f"- aesthetic SRCC: `{grounded_student.get('aestheticSrcc')}`",
        f"- elapsedS: `{grounded_student.get('elapsedS')}`",
        "",
        "## Grounded Persona Head",
        "",
        f"- rating SRCC: `{grounded_persona.get('ratingSrcc')}`",
        f"- all AUC: `{grounded_persona.get('allAuc')}`",
        f"- all AP: `{grounded_persona.get('allAp')}`",
        f"- elapsedS: `{grounded_persona.get('elapsedS')}`",
        "",
        "## Grounded Export",
        "",
        f"- persona included: `{grounded_export.get('personaIncluded')}`",
        f"- fp32 bytes: `{grounded_export.get('fp32Bytes')}`",
        f"- int8 bytes: `{grounded_export.get('int8Bytes')}`",
        "",
        "## Grounded Eval",
        "",
        f"- active EP: `{grounded_eval.get('activeEp')}`",
        f"- batch size: `{grounded_eval.get('batchSize')}`",
        f"- result count: `{grounded_eval.get('resultCount')}`",
        "",
        "## Selected Ratio Profiles",
        "",
    ]
    if profiles:
        for row in profiles:
            lines.append(
                f"- ratio `{row.get('ratio')}`: `{row.get('name')}` "
                f"(recall=`{row.get('recall')}`, negativePickRate=`{row.get('negativePickRate')}`, "
                f"selectedSimilarAdjacentPairs=`{row.get('selectedSimilarAdjacentPairs')}`)"
            )
    else:
        lines.append("- No selected ratio profile rows were available in this snapshot.")
    lines.extend(
        [
            "",
            "## Key Files",
            "",
            f"- `manifest.json`",
            f"- `artifact-index.csv`",
            f"- `paper-summary.json`",
            f"- `paper-summary.md`",
            f"- `remote/outputs/semantic-teacher-lab/eval-full/bench-grounded/summary.md`",
            "",
            f"Snapshot root: `{snapshot_dir}`",
            "",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def append_snapshot_history(local_root: Path, entry: dict[str, object]) -> None:
    history_path = local_root / "snapshot-history.jsonl"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    with history_path.open("a", encoding="utf-8", newline="") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def write_latest_snapshot_files(
    *,
    local_root: Path,
    snapshot_dir: Path,
    zip_path: Path | None,
    manifest: dict[str, object],
    paper_summary: dict[str, object],
) -> None:
    latest_payload = {
        "snapshotId": manifest["snapshotId"],
        "createdAtUtc": manifest["createdAtUtc"],
        "snapshotDir": str(snapshot_dir),
        "zipPath": str(zip_path) if zip_path else None,
        "manifestPath": str(snapshot_dir / "manifest.json"),
        "paperSummaryPath": str(snapshot_dir / "paper-summary.json"),
        "readmePath": str(snapshot_dir / "README.md"),
        "downloadTotals": manifest["totals"],
        "stageSummary": paper_summary["stageSummary"],
    }
    write_json(local_root / "latest-snapshot.json", latest_payload)
    shutil.copy2(snapshot_dir / "paper-summary.md", local_root / "latest-paper-summary.md")
    shutil.copy2(snapshot_dir / "README.md", local_root / "latest-readme.md")


def build_readme(
    *,
    snapshot_id: str,
    created_at: str,
    local_root: Path,
    zip_path: Path | None,
    args: argparse.Namespace,
    manifest: dict[str, object],
) -> str:
    totals = manifest["totals"]
    counts = Counter(item["category"] for item in manifest["artifacts"] if item["status"] == "downloaded")
    lines = [
        "# FrameCull Pro Semantic Teacher Lab Paper Snapshot",
        "",
        f"- snapshotId: `{snapshot_id}`",
        f"- createdAtUtc: `{created_at}`",
        f"- remoteLab: `{args.lab}`",
        f"- remoteWorkspace: `{args.workspace}`",
        f"- localDir: `{local_root}`",
        f"- zipArchive: `{zip_path}`" if zip_path else "- zipArchive: `(disabled)`",
        "",
        "## What This Snapshot Contains",
        "",
        "- Logs, Markdown reports, JSON/CSV results, and sample images for paper writing.",
        "- A provenance capture of current server status, active jobs, GPU info, and workspace git state.",
        "- A local copy of diagnosis outputs, task docs, and the exact training/eval scripts used to produce the current claims.",
        "- Distill, persona, export, quant-compare, semantic eval, and baseline Pro persona artifacts that would otherwise be scattered across different output trees.",
        "- Research notes and task definitions that explain why the current training path exists, not just what files were produced.",
        "- A manifest-first record that keeps missing or pending outputs visible while the pipeline is still running.",
        "- A paper summary layer (`paper-summary.json` / `paper-summary.md`) that extracts key teacher/student/persona/export/eval metrics.",
        "",
        "## What Is Skipped By Default",
        "",
        "- `*.pt` checkpoints",
        "- `*.onnx` exported model binaries",
        "- `*.npz` teacher feature blobs",
        "- `*.jsonl` full teacher label dumps",
        "- per-image raw VLM intermediate directories (`raw-vlm*`) unless `--include-raw-vlm` is explicitly enabled",
        "",
        "## Download Summary",
        "",
        f"- downloaded files: `{totals['downloaded']}`",
        f"- missing/pending items: `{totals['missing']}`",
        f"- skipped files: `{totals['skipped']}`",
        "",
        "## Category Counts",
        "",
    ]
    for category, count in sorted(counts.items()):
        lines.append(f"- `{category}`: `{count}`")
    lines.extend(
        [
            "",
            "## Provenance Files",
            "",
            "- `provenance/semantic-teacher-status.txt`",
            "- `provenance/active-jobs.txt`",
            "- `provenance/gpu.txt`",
            "- `provenance/workspace-head.txt`",
            "- `provenance/workspace-status.txt`",
            "- `provenance/local-workspace-head.txt`",
            "- `provenance/local-workspace-status.txt`",
            "",
            "## Key Index Files",
            "",
            "- `manifest.json`",
            "- `artifact-index.csv`",
            "- `paper-summary.json`",
            "- `paper-summary.md`",
            "",
            "## Notes",
            "",
        ]
    )
    lines.append("- `latest-snapshot.json` under `output/paper-artifacts/semantic-teacher-lab` is overwritten on each collection so you can jump straight to the newest paper archive.")
    lines.append("- Recommended tags for long runs: `before-run`, `after-teacher`, `after-distill`, `after-persona`, `after-export`, `after-eval`, `final`.")
    if int(totals["missing"]) > 0:
        lines.append("- Some upstream stages are still incomplete; the pending outputs are listed as `missing` in `manifest.json`.")
        lines.append("- Re-run this collector after the server pipeline finishes to create a fuller snapshot.")
    else:
        lines.append("- This snapshot has no missing tracked outputs and is suitable as a full paper-material archive.")
        lines.append("- Re-run only if you want a newer snapshot after code, weights, or reports change.")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    created = utc_now()
    stamp = created.strftime("%Y%m%d-%H%M%S")
    suffix = f"-{args.tag.strip()}" if args.tag.strip() else ""
    snapshot_id = f"semantic-teacher-paper-{stamp}{suffix}"
    snapshot_dir = args.local_root / snapshot_id
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, object] = {
        "schemaVersion": "framecull-semantic-paper-artifacts-v1",
        "snapshotId": snapshot_id,
        "createdAtUtc": iso_z(created),
        "remote": {
            "host": _ssh.HOST,
            "port": _ssh.PORT,
            "user": _ssh.USER,
            "lab": args.lab,
            "workspace": args.workspace,
        },
        "options": {
            "includeJsonl": args.include_jsonl,
            "includeNpz": args.include_npz,
            "includeModels": args.include_models,
            "includeCheckpoints": args.include_checkpoints,
            "includeRawVlm": args.include_raw_vlm,
            "zipSnapshot": args.zip_snapshot,
        },
        "artifacts": [],
        "provenance": [],
        "totals": {
            "downloaded": 0,
            "missing": 0,
            "skipped": 0,
        },
    }

    cli = _ssh._client()
    try:
        sftp = cli.open_sftp()
        try:
            provenance_dir = snapshot_dir / "provenance"
            for filename, command in REMOTE_STATUS_COMMANDS.items():
                payload = exec_remote(cli, command)
                local_path = provenance_dir / filename
                write_status_file(local_path, payload)
                manifest["provenance"].append(
                    {
                        "file": str(local_path),
                        "command": command,
                        "exitCode": payload["exitCode"],
                    }
                )

            repo_root = Path.cwd()
            for filename, command in LOCAL_STATUS_COMMANDS.items():
                payload = exec_local(command, repo_root)
                local_path = provenance_dir / filename
                write_status_file(local_path, payload)
                manifest["provenance"].append(
                    {
                        "file": str(local_path),
                        "command": payload["command"],
                        "exitCode": payload["exitCode"],
                    }
                )

            seen_remote_paths: set[str] = set()
            seen_local_paths: set[Path] = set()
            artifact_rows: list[dict[str, object]] = []
            dir_specs = list(DIR_SPECS)
            if args.include_raw_vlm:
                dir_specs.extend(RAW_VLM_DIR_SPECS)

            for spec in FILE_SPECS:
                remote_path = spec.remote_path
                if remote_path in seen_remote_paths:
                    continue
                seen_remote_paths.add(remote_path)
                if not remote_exists(sftp, remote_path):
                    artifact_rows.append(
                        {
                            "category": spec.category,
                            "sourceType": "remote",
                            "status": "missing",
                            "sourcePath": "",
                            "remotePath": remote_path,
                            "localPath": "",
                            "sizeBytes": "",
                            "modifiedAtUtc": "",
                            "sha256": "",
                            "note": "remote file missing or not produced yet",
                        }
                    )
                    continue
                path = PurePosixPath(remote_path)
                if not suffix_allowed(path, args):
                    artifact_rows.append(
                        {
                            "category": spec.category,
                            "sourceType": "remote",
                            "status": "skipped",
                            "sourcePath": "",
                            "remotePath": remote_path,
                            "localPath": "",
                            "sizeBytes": "",
                            "modifiedAtUtc": "",
                            "sha256": "",
                            "note": f"suffix {path.suffix.lower()} skipped by current options",
                        }
                    )
                    continue
                row = download_one(
                    sftp=sftp,
                    remote_path=remote_path,
                    local_root=snapshot_dir,
                    lab_root=args.lab,
                    category=spec.category,
                )
                row["note"] = ""
                artifact_rows.append(row)

            for spec in dir_specs:
                remote_dir = spec.remote_path
                if not remote_exists(sftp, remote_dir):
                    artifact_rows.append(
                        {
                            "category": spec.category,
                            "sourceType": "remote",
                            "status": "missing",
                            "sourcePath": "",
                            "remotePath": remote_dir,
                            "localPath": "",
                            "sizeBytes": "",
                            "modifiedAtUtc": "",
                            "sha256": "",
                            "note": "remote directory missing or not produced yet",
                        }
                    )
                    continue
                for remote_path in walk_remote_files(sftp, remote_dir, recursive=spec.recursive):
                    if remote_path in seen_remote_paths:
                        continue
                    seen_remote_paths.add(remote_path)
                    path = PurePosixPath(remote_path)
                    if not suffix_allowed(path, args):
                        artifact_rows.append(
                            {
                                "category": spec.category,
                                "sourceType": "remote",
                                "status": "skipped",
                                "sourcePath": "",
                                "remotePath": remote_path,
                                "localPath": "",
                                "sizeBytes": "",
                                "modifiedAtUtc": "",
                                "sha256": "",
                                "note": f"suffix {path.suffix.lower()} skipped by current options",
                            }
                        )
                        continue
                    row = download_one(
                        sftp=sftp,
                        remote_path=remote_path,
                        local_root=snapshot_dir,
                        lab_root=args.lab,
                        category=spec.category,
                    )
                    row["note"] = ""
                    artifact_rows.append(row)

            for spec in LOCAL_FILE_SPECS:
                source_path = Path(spec.remote_path)
                resolved = source_path if source_path.is_absolute() else (repo_root / source_path)
                if resolved in seen_local_paths:
                    continue
                seen_local_paths.add(resolved)
                if not resolved.exists():
                    artifact_rows.append(
                        {
                            "category": spec.category,
                            "sourceType": "local",
                            "status": "missing",
                            "sourcePath": str(resolved),
                            "remotePath": "",
                            "localPath": "",
                            "sizeBytes": "",
                            "modifiedAtUtc": "",
                            "sha256": "",
                            "note": "local file missing or not produced yet",
                        }
                    )
                    continue
                if not suffix_allowed(PurePosixPath(resolved.as_posix()), args):
                    artifact_rows.append(
                        {
                            "category": spec.category,
                            "sourceType": "local",
                            "status": "skipped",
                            "sourcePath": str(resolved),
                            "remotePath": "",
                            "localPath": "",
                            "sizeBytes": "",
                            "modifiedAtUtc": "",
                            "sha256": "",
                            "note": f"suffix {resolved.suffix.lower()} skipped by current options",
                        }
                    )
                    continue
                row = copy_one_local(
                    source_path=resolved,
                    local_root=snapshot_dir,
                    repo_root=repo_root,
                    category=spec.category,
                )
                row["note"] = ""
                artifact_rows.append(row)

            for spec in LOCAL_DIR_SPECS:
                root = Path(spec.remote_path)
                resolved_root = root if root.is_absolute() else (repo_root / root)
                if not resolved_root.exists():
                    artifact_rows.append(
                        {
                            "category": spec.category,
                            "sourceType": "local",
                            "status": "missing",
                            "sourcePath": str(resolved_root),
                            "remotePath": "",
                            "localPath": "",
                            "sizeBytes": "",
                            "modifiedAtUtc": "",
                            "sha256": "",
                            "note": "local directory missing or not produced yet",
                        }
                    )
                    continue
                for source_path in walk_local_files(resolved_root, recursive=spec.recursive):
                    if source_path in seen_local_paths:
                        continue
                    seen_local_paths.add(source_path)
                    if not suffix_allowed(PurePosixPath(source_path.as_posix()), args):
                        artifact_rows.append(
                            {
                                "category": spec.category,
                                "sourceType": "local",
                                "status": "skipped",
                                "sourcePath": str(source_path),
                                "remotePath": "",
                                "localPath": "",
                                "sizeBytes": "",
                                "modifiedAtUtc": "",
                                "sha256": "",
                                "note": f"suffix {source_path.suffix.lower()} skipped by current options",
                            }
                        )
                        continue
                    row = copy_one_local(
                        source_path=source_path,
                        local_root=snapshot_dir,
                        repo_root=repo_root,
                        category=spec.category,
                    )
                    row["note"] = ""
                    artifact_rows.append(row)

            manifest["artifacts"] = artifact_rows
            totals = Counter(row["status"] for row in artifact_rows)
            manifest["totals"] = {
                "downloaded": int(totals.get("downloaded", 0)),
                "missing": int(totals.get("missing", 0)),
                "skipped": int(totals.get("skipped", 0)),
            }

            write_json(snapshot_dir / "manifest.json", manifest)
            write_index_csv(snapshot_dir / "artifact-index.csv", artifact_rows)

            paper_summary = {
                "schemaVersion": "framecull-semantic-paper-summary-v1",
                "snapshotId": snapshot_id,
                "createdAtUtc": manifest["createdAtUtc"],
                "downloadTotals": manifest["totals"],
                "stageSummary": build_stage_summary(snapshot_dir, args.lab),
            }
            write_json(snapshot_dir / "paper-summary.json", paper_summary)
            (snapshot_dir / "paper-summary.md").write_text(
                build_paper_summary_markdown(
                    snapshot_dir=snapshot_dir,
                    summary=paper_summary["stageSummary"],
                ),
                encoding="utf-8",
            )

            zip_path: Path | None = None
            if args.zip_snapshot:
                zip_base = snapshot_dir.parent / snapshot_dir.name
                shutil.make_archive(str(zip_base), "zip", root_dir=snapshot_dir.parent, base_dir=snapshot_dir.name)
                zip_path = zip_base.with_suffix(".zip")

            readme = build_readme(
                snapshot_id=snapshot_id,
                created_at=manifest["createdAtUtc"],
                local_root=snapshot_dir,
                zip_path=zip_path,
                args=args,
                manifest=manifest,
            )
            (snapshot_dir / "README.md").write_text(readme, encoding="utf-8")
            write_latest_snapshot_files(
                local_root=args.local_root,
                snapshot_dir=snapshot_dir,
                zip_path=zip_path,
                manifest=manifest,
                paper_summary=paper_summary,
            )
            append_snapshot_history(
                args.local_root,
                {
                    "snapshotId": snapshot_id,
                    "createdAtUtc": manifest["createdAtUtc"],
                    "snapshotDir": str(snapshot_dir),
                    "zipPath": str(zip_path) if zip_path else None,
                    "manifestPath": str(snapshot_dir / "manifest.json"),
                    "paperSummaryPath": str(snapshot_dir / "paper-summary.json"),
                    "downloadTotals": manifest["totals"],
                    "stageSummary": paper_summary["stageSummary"],
                },
            )
        finally:
            sftp.close()
    finally:
        cli.close()

    print(json.dumps(
        {
            "snapshotId": snapshot_id,
            "snapshotDir": str(snapshot_dir),
            "zipPath": str(snapshot_dir.with_suffix(".zip")) if args.zip_snapshot else None,
            "manifest": str(snapshot_dir / "manifest.json"),
            "indexCsv": str(snapshot_dir / "artifact-index.csv"),
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
