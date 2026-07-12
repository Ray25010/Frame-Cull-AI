#!/usr/bin/env bash
# Wait for full grounded+flat teachers, then train/export/eval Semantic Student V2
# with freshness checks so old mixed-lineage artifacts are not silently reused.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
SLEEP_SECONDS="${FRAMECULL_WATCH_SLEEP_SECONDS:-300}"

GROUND="$LAB/features/semantic-teacher/semantic-teacher-v1.jsonl"
FLAT="$LAB/features/semantic-teacher/semantic-teacher-v1-flat.jsonl"

GROUND_QA_DIR="$LAB/outputs/semantic-teacher-lab/teacher-qa-grounded-full"
FLAT_QA_DIR="$LAB/outputs/semantic-teacher-lab/teacher-qa-flat-full"
GROUND_QA="$GROUND_QA_DIR/teacher-quality-report.json"
FLAT_QA="$FLAT_QA_DIR/teacher-quality-report.json"

GROUND_STUDENT_DIR="$LAB/outputs/semantic-student/grounded-convnext"
FLAT_STUDENT_DIR="$LAB/outputs/semantic-student/flat-convnext"
GROUND_STUDENT="$GROUND_STUDENT_DIR/student-best.pt"
FLAT_STUDENT="$FLAT_STUDENT_DIR/student-best.pt"
GROUND_STUDENT_REPORT="$GROUND_STUDENT_DIR/training-report.json"
FLAT_STUDENT_REPORT="$FLAT_STUDENT_DIR/training-report.json"
GROUND_STUDENT_LOG="$LAB/logs/semantic-student-grounded.log"
FLAT_STUDENT_LOG="$LAB/logs/semantic-student-flat.log"

GROUND_PERSONA_DIR="$LAB/outputs/semantic-student/grounded-convnext-persona"
FLAT_PERSONA_DIR="$LAB/outputs/semantic-student/flat-convnext-persona"
GROUND_PERSONA="$GROUND_PERSONA_DIR/persona-head.pt"
FLAT_PERSONA="$FLAT_PERSONA_DIR/persona-head.pt"
GROUND_PERSONA_SUMMARY="$GROUND_PERSONA_DIR/summary.json"
FLAT_PERSONA_SUMMARY="$FLAT_PERSONA_DIR/summary.json"
GROUND_PERSONA_LOG="$LAB/logs/semantic-persona-grounded.log"
FLAT_PERSONA_LOG="$LAB/logs/semantic-persona-flat.log"

GROUND_EXPORT_DIR="$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext"
FLAT_EXPORT_DIR="$LAB/outputs/pro-models/semantic_student_v2_flat_convnext"
GROUND_MANIFEST="$GROUND_EXPORT_DIR/manifest.int8.json"
FLAT_MANIFEST="$FLAT_EXPORT_DIR/manifest.int8.json"
GROUND_EXPORT_REPORT="$GROUND_EXPORT_DIR/export-report.json"
FLAT_EXPORT_REPORT="$FLAT_EXPORT_DIR/export-report.json"
GROUND_EXPORT_TRAINING_REPORT="$GROUND_EXPORT_DIR/training-report.json"
FLAT_EXPORT_TRAINING_REPORT="$FLAT_EXPORT_DIR/training-report.json"
GROUND_EXPORT_LOG="$LAB/logs/semantic-export-grounded.log"
FLAT_EXPORT_LOG="$LAB/logs/semantic-export-flat.log"

GROUND_EVAL_DIR="$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded"
FLAT_EVAL_DIR="$LAB/outputs/semantic-teacher-lab/eval-full/bench-flat"
GROUND_SUMMARY="$GROUND_EVAL_DIR/summary.md"
FLAT_SUMMARY="$FLAT_EVAL_DIR/summary.md"
GROUND_INFER="$GROUND_EVAL_DIR/pro-infer-latency.json"
FLAT_INFER="$FLAT_EVAL_DIR/pro-infer-latency.json"
GROUND_EVAL_AUDIT="$GROUND_EVAL_DIR/ai-culling-bench-pro-semantic-eval-input.json"
FLAT_EVAL_AUDIT="$FLAT_EVAL_DIR/ai-culling-bench-pro-semantic-eval-input.json"
GROUND_EVAL_META="$GROUND_EVAL_DIR/eval-run-meta.json"
FLAT_EVAL_META="$FLAT_EVAL_DIR/eval-run-meta.json"
GROUND_EVAL_LOG="$LAB/logs/semantic-eval-grounded.log"
FLAT_EVAL_LOG="$LAB/logs/semantic-eval-flat.log"

LICENSE="$LAB/outputs/semantic-teacher-lab/teacher-license-clearance.md"
SELECTED_CONFIG="$WORKSPACE/output/ai-bench/ratio-aware-ai-picks/selected-config-by-ratio.json"
INPUT="$LAB/outputs/semantic-teacher-lab/phase0/all-images.json"

cd "$WORKSPACE"
mkdir -p "$LAB/logs"

sync_phase_outputs() {
  "$PY" tools/pro-train/sync_semantic_teacher_phase_outputs.py --lab "$LAB" >/dev/null || true
}

expected_count() {
  FRAMECULL_LAB="$LAB" "$PY" - <<'PY'
import json
import os
from pathlib import Path
lab = Path(os.environ.get("FRAMECULL_LAB", "/data/FrameCullModelLab"))
items = json.loads((lab / "outputs/semantic-teacher-lab/phase0/all-images.json").read_text())
print(len([x for x in items if x.get("teacherImagePath")]))
PY
}

line_count() {
  local file="$1"
  if [[ -f "$file" ]]; then
    wc -l < "$file"
  else
    echo 0
  fi
}

timestamp() {
  date +%Y%m%d-%H%M%S
}

archive_paths() {
  local stamp
  stamp="$(timestamp)"
  for path in "$@"; do
    if [[ -e "$path" ]]; then
      local dest="${path}.stale-$stamp"
      mv "$path" "$dest"
      echo "[student-watch] archived stale artifact $path -> $dest"
    fi
  done
}

run_with_log() {
  local log_file="$1"
  shift
  mkdir -p "$(dirname "$log_file")"
  set +e
  "$@" 2>&1 | tee "$log_file"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

job_running() {
  local pattern="$1"
  ps -eo cmd | grep -E "$pattern" | grep -v grep >/dev/null
}

teacher_job_running_for() {
  local output="$1"
  ps -eo cmd | grep "tools/pro-train/run_semantic_teacher.py" | grep -- "--out $output" | grep -v grep >/dev/null
}

any_teacher_job_running() {
  ps -eo cmd | grep "tools/pro-train/run_semantic_teacher.py" | grep -v grep >/dev/null
}

completion_count() {
  local output="$1"
  local summary="$2"
  "$PY" - <<PY
import json
import subprocess
cmd = [
    r"$PY",
    "tools/pro-train/inspect_teacher_lineage.py",
    "--input",
    r"$INPUT",
    "--output",
    r"$output",
    "--summary",
    r"$summary",
]
payload = json.loads(subprocess.check_output(cmd, text=True))
print(int(payload.get("progress") or 0))
PY
}

lineage_safe_when_idle() {
  local output="$1"
  local summary="$2"
  "$PY" - <<PY
import json
import subprocess
import sys
cmd = [
    r"$PY",
    "tools/pro-train/inspect_teacher_lineage.py",
    "--input",
    r"$INPUT",
    "--output",
    r"$output",
    "--summary",
    r"$summary",
]
payload = json.loads(subprocess.check_output(cmd, text=True))
sys.exit(0 if payload.get("resumeSafe") else 1)
PY
}

archive_stale_teacher_output_if_idle() {
  local label="$1"
  local output="$2"
  local summary="$3"
  local log_file="$4"
  if teacher_job_running_for "$output"; then
    return 0
  fi
  if lineage_safe_when_idle "$output" "$summary"; then
    return 0
  fi
  archive_paths "$output" "$summary" "${output%.jsonl}.failures.csv" "$log_file"
  echo "[student-watch] archived idle stale teacher lineage for $label"
}

wait_for_completion() {
  local label="$1"
  local file="$2"
  local summary="$3"
  local expected="$4"
  while [[ "$(completion_count "$file" "$summary")" -lt "$expected" ]]; do
    local completed
    completed="$(completion_count "$file" "$summary")"
    local lines
    lines="$(line_count "$file")"
    echo "[student-watch] waiting $label progress=$completed/$expected success_lines=$lines time=$(date -Is)"
    sleep "$SLEEP_SECONDS"
  done
}

wait_for_teacher_gpu_idle() {
  local label="$1"
  while any_teacher_job_running; do
    echo "[student-watch] waiting teacher GPU idle before $label time=$(date -Is)"
    sleep "$SLEEP_SECONDS"
  done
}

teacher_qa_fresh() {
  local teacher="$1"
  local qa_json="$2"
  [[ -s "$qa_json" && "$qa_json" -nt "$teacher" ]]
}

ensure_teacher_qa() {
  local label="$1"
  local teacher="$2"
  local qa_dir="$3"
  local qa_json="$4"
  local extra_schema_arg="${5:-}"
  local extra_audit_arg="${6:-}"
  if teacher_qa_fresh "$teacher" "$qa_json"; then
    echo "[student-watch] $label QA already fresh: $qa_json"
    return 0
  fi
  if [[ -e "$qa_dir" ]]; then
    archive_paths "$qa_dir"
  fi
  echo "[student-watch] building $label QA"
  if [[ -n "$extra_schema_arg" ]]; then
    "$PY" tools/pro-train/semantic_teacher_schema.py "$teacher" "$extra_schema_arg"
  else
    "$PY" tools/pro-train/semantic_teacher_schema.py "$teacher"
  fi
  if [[ -n "$extra_audit_arg" ]]; then
    "$PY" tools/pro-train/audit_semantic_teacher.py \
      --teacher "$teacher" \
      --out "$qa_dir" \
      "$extra_audit_arg"
  else
    "$PY" tools/pro-train/audit_semantic_teacher.py \
      --teacher "$teacher" \
      --out "$qa_dir"
  fi
  sync_phase_outputs
}

student_fresh() {
  local teacher="$1"
  local student="$2"
  local report="$3"
  local flat_scalar="$4"
  FRAMECULL_TEACHER="$teacher" \
  FRAMECULL_STUDENT="$student" \
  FRAMECULL_REPORT="$report" \
  FRAMECULL_EXPECTED="$EXPECTED" \
  FRAMECULL_FLAT_SCALAR="$flat_scalar" \
  "$PY" - <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

teacher = Path(os.environ["FRAMECULL_TEACHER"])
student = Path(os.environ["FRAMECULL_STUDENT"])
report = Path(os.environ["FRAMECULL_REPORT"])
expected = int(os.environ["FRAMECULL_EXPECTED"])
flat_scalar = bool(int(os.environ["FRAMECULL_FLAT_SCALAR"]))

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

if not student.exists() or not report.exists():
    sys.exit(1)
try:
    payload = json.loads(report.read_text(encoding="utf-8"))
except Exception:
    sys.exit(1)
teacher_path = str(payload.get("semanticTeacher") or "")
teacher_sha = payload.get("semanticTeacherSha256")
same_teacher = Path(teacher_path) == teacher
same_sha = (teacher_sha is None) or (teacher_sha == sha256(teacher))
same_items = int(payload.get("totalItems") or 0) == expected
same_flat = bool(payload.get("teacherFlatScalar")) == flat_scalar
# Teacher content drift is guarded by sha/path/count checks above. Requiring the
# checkpoint to be newer than the teacher file causes false invalidation when we
# repair or resync teacher outputs without changing their content.
mtime_ok = report.stat().st_mtime >= student.stat().st_mtime
sys.exit(0 if all((same_teacher, same_sha, same_items, same_flat, mtime_ok)) else 1)
PY
}

persona_fresh() {
  local student="$1"
  local persona="$2"
  local summary="$3"
  FRAMECULL_STUDENT="$student" \
  FRAMECULL_PERSONA="$persona" \
  FRAMECULL_SUMMARY="$summary" \
  "$PY" - <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

student = Path(os.environ["FRAMECULL_STUDENT"])
persona = Path(os.environ["FRAMECULL_PERSONA"])
summary = Path(os.environ["FRAMECULL_SUMMARY"])

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

if not student.exists() or not persona.exists() or not summary.exists():
    sys.exit(1)
try:
    payload = json.loads(summary.read_text(encoding="utf-8"))
except Exception:
    sys.exit(1)
student_path = Path(str(payload.get("student") or ""))
student_sha = payload.get("studentSha256")
same_student = student_path == student
same_sha = (student_sha is None) or (student_sha == sha256(student))
mtime_ok = persona.stat().st_mtime >= student.stat().st_mtime and summary.stat().st_mtime >= persona.stat().st_mtime
sys.exit(0 if all((same_student, same_sha, mtime_ok)) else 1)
PY
}

export_fresh() {
  local student="$1"
  local persona="$2"
  local manifest="$3"
  local report="$4"
  local exported_training_report="$5"
  FRAMECULL_STUDENT="$student" \
  FRAMECULL_PERSONA="$persona" \
  FRAMECULL_MANIFEST="$manifest" \
  FRAMECULL_REPORT="$report" \
  FRAMECULL_EXPORTED_TRAINING_REPORT="$exported_training_report" \
  "$PY" - <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

student = Path(os.environ["FRAMECULL_STUDENT"])
persona = Path(os.environ["FRAMECULL_PERSONA"])
manifest = Path(os.environ["FRAMECULL_MANIFEST"])
report = Path(os.environ["FRAMECULL_REPORT"])
exported_training_report = Path(os.environ["FRAMECULL_EXPORTED_TRAINING_REPORT"])

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

if not student.exists() or not manifest.exists() or not report.exists() or not exported_training_report.exists():
    sys.exit(1)
try:
    payload = json.loads(report.read_text(encoding="utf-8"))
    exported_training_payload = json.loads(exported_training_report.read_text(encoding="utf-8"))
except Exception:
    sys.exit(1)
student_meta = payload.get("student") or {}
persona_meta = payload.get("persona") or {}
student_report_meta = payload.get("studentTrainingReport") or {}
same_student = Path(str(student_meta.get("path") or "")) == student
same_student_sha = student_meta.get("sha256") == sha256(student)
same_report_source = Path(str(student_report_meta.get("source") or "")) == student.with_name("training-report.json")
same_report_copy = Path(str(student_report_meta.get("copiedPath") or "")) == exported_training_report
report_copy_flag = bool(student_report_meta.get("copied")) is True
same_student_report_schema = (exported_training_payload.get("schema") or "") == "framecull-pro-semantic-student-training-v1"
if persona.exists():
    same_persona = Path(str(persona_meta.get("path") or "")) == persona
    same_persona_sha = persona_meta.get("sha256") == sha256(persona)
else:
    same_persona = persona_meta.get("path") in (None, "", "null")
    same_persona_sha = True
mtime_ok = (
    manifest.stat().st_mtime >= student.stat().st_mtime
    and exported_training_report.stat().st_mtime >= student.stat().st_mtime
    and report.stat().st_mtime >= manifest.stat().st_mtime
    and report.stat().st_mtime >= exported_training_report.stat().st_mtime
)
if persona.exists():
    mtime_ok = mtime_ok and manifest.stat().st_mtime >= persona.stat().st_mtime
sys.exit(
    0
    if all(
        (
            same_student,
            same_student_sha,
            same_persona,
            same_persona_sha,
            same_report_source,
            same_report_copy,
            report_copy_flag,
            same_student_report_schema,
            mtime_ok,
        )
    )
    else 1
)
PY
}

eval_fresh() {
  local manifest="$1"
  local infer_json="$2"
  local summary="$3"
  local eval_audit="$4"
  local teacher_qa="$5"
  local eval_meta="$6"
  local teacher="$7"
  local expected="$8"
  local flat_scalar="$9"
  FRAMECULL_MANIFEST="$manifest" \
  FRAMECULL_INFER="$infer_json" \
  FRAMECULL_SUMMARY="$summary" \
  FRAMECULL_AUDIT="$eval_audit" \
  FRAMECULL_TEACHER_QA="$teacher_qa" \
  FRAMECULL_EVAL_META="$eval_meta" \
  FRAMECULL_TEACHER="$teacher" \
  FRAMECULL_EXPECTED="$expected" \
  FRAMECULL_FLAT_SCALAR="$flat_scalar" \
  FRAMECULL_LICENSE="$LICENSE" \
  FRAMECULL_SELECTED_CONFIG="$SELECTED_CONFIG" \
  "$PY" - <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

manifest = Path(os.environ["FRAMECULL_MANIFEST"])
infer_json = Path(os.environ["FRAMECULL_INFER"])
summary = Path(os.environ["FRAMECULL_SUMMARY"])
eval_audit = Path(os.environ["FRAMECULL_AUDIT"])
teacher_qa = Path(os.environ["FRAMECULL_TEACHER_QA"])
eval_meta = Path(os.environ["FRAMECULL_EVAL_META"])
teacher = Path(os.environ["FRAMECULL_TEACHER"])
expected = int(os.environ["FRAMECULL_EXPECTED"])
flat_scalar = bool(int(os.environ["FRAMECULL_FLAT_SCALAR"]))
license_path = Path(os.environ["FRAMECULL_LICENSE"])
selected_config = Path(os.environ["FRAMECULL_SELECTED_CONFIG"])

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

deps = [manifest, eval_audit, teacher_qa, eval_meta, teacher, license_path, selected_config]
if not all(path.exists() for path in deps) or not infer_json.exists() or not summary.exists():
    sys.exit(1)
try:
    infer_payload = json.loads(infer_json.read_text(encoding="utf-8"))
    audit_payload = json.loads(eval_audit.read_text(encoding="utf-8-sig"))
    meta_payload = json.loads(eval_meta.read_text(encoding="utf-8"))
except Exception:
    sys.exit(1)
same_manifest = Path(str(infer_payload.get("manifestPath") or "")) == manifest
same_count = int(infer_payload.get("count") or -1) == len(audit_payload.get("photoSummaries") or [])
meta_manifest_sha = str(meta_payload.get("manifestSha256") or "")
meta_teacher_sha = str(meta_payload.get("semanticTeacherSha256") or "")
meta_teacher_count = int(meta_payload.get("semanticTeacherRecordCount") or 0)
meta_flat_scalar = bool(meta_payload.get("teacherFlatScalar"))
same_meta_manifest = meta_manifest_sha == sha256(manifest)
same_meta_teacher = meta_teacher_sha == sha256(teacher)
same_meta_count = meta_teacher_count == expected
same_meta_flat = meta_flat_scalar == flat_scalar
mtime_ok = (
    all(infer_json.stat().st_mtime >= dep.stat().st_mtime for dep in [manifest, eval_audit, teacher_qa, teacher, license_path, selected_config])
    and eval_meta.stat().st_mtime >= infer_json.stat().st_mtime
    and summary.stat().st_mtime >= infer_json.stat().st_mtime
    and summary.stat().st_mtime >= eval_meta.stat().st_mtime
)
sys.exit(0 if all((
    same_manifest,
    same_count,
    same_meta_manifest,
    same_meta_teacher,
    same_meta_count,
    same_meta_flat,
    mtime_ok,
)) else 1)
PY
}

grounded_student_fresh() { student_fresh "$GROUND" "$GROUND_STUDENT" "$GROUND_STUDENT_REPORT" 0; }
flat_student_fresh() { student_fresh "$FLAT" "$FLAT_STUDENT" "$FLAT_STUDENT_REPORT" 1; }
grounded_persona_fresh() { persona_fresh "$GROUND_STUDENT" "$GROUND_PERSONA" "$GROUND_PERSONA_SUMMARY"; }
flat_persona_fresh() { persona_fresh "$FLAT_STUDENT" "$FLAT_PERSONA" "$FLAT_PERSONA_SUMMARY"; }
grounded_export_fresh() { export_fresh "$GROUND_STUDENT" "$GROUND_PERSONA" "$GROUND_MANIFEST" "$GROUND_EXPORT_REPORT" "$GROUND_EXPORT_TRAINING_REPORT"; }
flat_export_fresh() { export_fresh "$FLAT_STUDENT" "$FLAT_PERSONA" "$FLAT_MANIFEST" "$FLAT_EXPORT_REPORT" "$FLAT_EXPORT_TRAINING_REPORT"; }
grounded_eval_fresh() { eval_fresh "$GROUND_MANIFEST" "$GROUND_INFER" "$GROUND_SUMMARY" "$GROUND_EVAL_AUDIT" "$GROUND_QA" "$GROUND_EVAL_META" "$GROUND" "$EXPECTED" 0; }
flat_eval_fresh() { eval_fresh "$FLAT_MANIFEST" "$FLAT_INFER" "$FLAT_SUMMARY" "$FLAT_EVAL_AUDIT" "$FLAT_QA" "$FLAT_EVAL_META" "$FLAT" "$EXPECTED" 1; }

ensure_step() {
  local label="$1"
  local pattern="$2"
  local fresh_fn="$3"
  local step_log="$4"
  shift 4
  local cleanup_paths=()
  while [[ "$1" != "--" ]]; do
    cleanup_paths+=("$1")
    shift
  done
  shift
  local cmd=("$@")

  if "$fresh_fn"; then
    echo "[student-watch] $label already fresh"
    return 0
  fi

  if job_running "$pattern"; then
    echo "[student-watch] $label already running"
    while job_running "$pattern"; do
      if "$fresh_fn"; then
        echo "[student-watch] $label finished via existing job"
        return 0
      fi
      echo "[student-watch] waiting $label running-job time=$(date -Is)"
      sleep "$SLEEP_SECONDS"
    done
    if "$fresh_fn"; then
      echo "[student-watch] $label finished after prior job exit"
      return 0
    fi
  fi

  if [[ "${#cleanup_paths[@]}" -gt 0 ]]; then
    archive_paths "${cleanup_paths[@]}"
  fi
  echo "[student-watch] launching $label"
  run_with_log "$step_log" "${cmd[@]}"
  while ! "$fresh_fn"; do
    if ! job_running "$pattern"; then
      echo "[student-watch][error] $label stopped without producing a fresh artifact" >&2
      return 1
    fi
    echo "[student-watch] waiting $label fresh-artifact time=$(date -Is)"
    sleep "$SLEEP_SECONDS"
  done
  echo "[student-watch] $label fresh artifact ready"
}

EXPECTED="$(expected_count)"
echo "[student-watch] expected=$EXPECTED"

archive_stale_teacher_output_if_idle grounded "$GROUND" "$LAB/features/semantic-teacher/semantic-teacher-v1.summary.json" "$LAB/logs/semantic-teacher-grounded.log"
archive_stale_teacher_output_if_idle flat "$FLAT" "$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json" "$LAB/logs/semantic-teacher-flat.log"
sync_phase_outputs

wait_for_completion grounded "$GROUND" "$LAB/features/semantic-teacher/semantic-teacher-v1.summary.json" "$EXPECTED"
ensure_teacher_qa grounded "$GROUND" "$GROUND_QA_DIR" "$GROUND_QA"
if ! grounded_student_fresh; then
  wait_for_teacher_gpu_idle "grounded semantic student"
fi
ensure_step \
  "grounded semantic student" \
  "train_semantic_student.py.*outputs/semantic-student/grounded-convnext|run_semantic_student_server.sh grounded" \
  grounded_student_fresh \
  "$GROUND_STUDENT_LOG" \
  "$GROUND_STUDENT_DIR" \
  "$GROUND_STUDENT_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_student_server.sh" grounded
ensure_step \
  "grounded persona head" \
  "train_persona_head.py.*outputs/semantic-student/grounded-convnext-persona|run_semantic_persona_server.sh grounded" \
  grounded_persona_fresh \
  "$GROUND_PERSONA_LOG" \
  "$GROUND_PERSONA_DIR" \
  "$GROUND_PERSONA_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_persona_server.sh" grounded
ensure_step \
  "grounded semantic export" \
  "export_pro_semantic_onnx.py.*semantic_student_v2_grounded_convnext|run_semantic_export_server.sh grounded" \
  grounded_export_fresh \
  "$GROUND_EXPORT_LOG" \
  "$GROUND_EXPORT_DIR" \
  "$GROUND_EXPORT_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_export_server.sh" grounded
ensure_step \
  "grounded semantic eval" \
  "run_semantic_eval_server.sh grounded|run_pro_semantic_onnx_infer.py.*bench-grounded" \
  grounded_eval_fresh \
  "$GROUND_EVAL_LOG" \
  "$GROUND_EVAL_DIR" \
  "$GROUND_EVAL_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_eval_server.sh" grounded

wait_for_completion flat "$FLAT" "$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json" "$EXPECTED"
ensure_teacher_qa flat "$FLAT" "$FLAT_QA_DIR" "$FLAT_QA" "--allow-flat-scalar" "--flat-scalar"
if ! flat_student_fresh; then
  wait_for_teacher_gpu_idle "flat semantic student"
fi
ensure_step \
  "flat semantic student" \
  "train_semantic_student.py.*outputs/semantic-student/flat-convnext|run_semantic_student_server.sh flat" \
  flat_student_fresh \
  "$FLAT_STUDENT_LOG" \
  "$FLAT_STUDENT_DIR" \
  "$FLAT_STUDENT_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_student_server.sh" flat
ensure_step \
  "flat persona head" \
  "train_persona_head.py.*outputs/semantic-student/flat-convnext-persona|run_semantic_persona_server.sh flat" \
  flat_persona_fresh \
  "$FLAT_PERSONA_LOG" \
  "$FLAT_PERSONA_DIR" \
  "$FLAT_PERSONA_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_persona_server.sh" flat
ensure_step \
  "flat semantic export" \
  "export_pro_semantic_onnx.py.*semantic_student_v2_flat_convnext|run_semantic_export_server.sh flat" \
  flat_export_fresh \
  "$FLAT_EXPORT_LOG" \
  "$FLAT_EXPORT_DIR" \
  "$FLAT_EXPORT_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_export_server.sh" flat
ensure_step \
  "flat semantic eval" \
  "run_semantic_eval_server.sh flat|run_pro_semantic_onnx_infer.py.*bench-flat" \
  flat_eval_fresh \
  "$FLAT_EVAL_LOG" \
  "$FLAT_EVAL_DIR" \
  "$FLAT_EVAL_LOG" \
  -- \
  "$WORKSPACE/tools/pro-train/run_semantic_eval_server.sh" flat

"$PY" tools/pro-train/verify_semantic_teacher_lab_outputs.py \
  --lab "$LAB" \
  --output-json "$GROUND_EVAL_DIR/final-output-audit.json" \
  --output-md "$GROUND_EVAL_DIR/final-output-audit.md"

echo "[student-watch] semantic student pipeline complete"
