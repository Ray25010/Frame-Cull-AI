#!/usr/bin/env bash
# Wait for grounded Semantic Teacher to finish, validate it, then launch flat-scalar.
# This script is safe to run in the background while the grounded job is active.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
SLEEP_SECONDS="${FRAMECULL_WATCH_SLEEP_SECONDS:-300}"

GROUND="$LAB/features/semantic-teacher/semantic-teacher-v1.jsonl"
GROUND_SUMMARY="$LAB/features/semantic-teacher/semantic-teacher-v1.summary.json"
FLAT="$LAB/features/semantic-teacher/semantic-teacher-v1-flat.jsonl"
FLAT_LOG="$LAB/logs/semantic-teacher-flat.log"
INPUT="$LAB/outputs/semantic-teacher-lab/phase0/all-images.json"
GROUND_FAILURES="${GROUND%.jsonl}.failures.csv"
FLAT_FAILURES="${FLAT%.jsonl}.failures.csv"

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
lab=Path(os.environ.get('FRAMECULL_LAB', '/data/FrameCullModelLab'))
items=json.loads((lab/'outputs/semantic-teacher-lab/phase0/all-images.json').read_text())
print(len([x for x in items if x.get('teacherImagePath')]))
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

teacher_running_for() {
  local output="$1"
  ps -eo pid,cmd | grep "tools/pro-train/run_semantic_teacher.py" | grep -- "--out $output" | grep -v grep
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
  if teacher_running_for "$output" >/dev/null; then
    return 0
  fi
  if lineage_safe_when_idle "$output" "$summary"; then
    return 0
  fi
  local stamp
  stamp="$(timestamp)"
  for stale in "$output" "$summary" "${output%.jsonl}.failures.csv"; do
    if [[ -e "$stale" ]]; then
      local dest="${stale}.stale-$stamp"
      mv "$stale" "$dest"
      echo "[watch] archived stale $label artifact $stale -> $dest"
    fi
  done
  if [[ -e "$log_file" ]]; then
    local log_dest="${log_file}.stale-$stamp"
    mv "$log_file" "$log_dest"
    echo "[watch] archived stale $label log $log_file -> $log_dest"
  fi
}

student_watch_running() {
  ps -eo cmd | grep "tools/pro-train/watch_semantic_student_pipeline_server.sh" | grep -v grep >/dev/null
}

launch_teacher() {
  local mode="$1"
  local log="$2"
  echo "[watch] launching/resuming $mode teacher"
  setsid "$WORKSPACE/tools/pro-train/run_semantic_teacher_server.sh" "$mode" >> "$log" 2>&1 < /dev/null &
  echo $! > "$LAB/logs/semantic-teacher-${mode}.pid"
  echo "[watch] $mode pid=$(cat "$LAB/logs/semantic-teacher-${mode}.pid") log=$log"
}

launch_student_watch() {
  if student_watch_running; then
    echo "[watch] semantic student watcher already running"
    return 0
  fi
  echo "[watch] launching semantic student watcher"
  setsid "$WORKSPACE/tools/pro-train/watch_semantic_student_pipeline_server.sh" >> "$LAB/logs/semantic-student-watch.log" 2>&1 < /dev/null &
  echo $! > "$LAB/logs/semantic-student-watch.pid"
  echo "[watch] semantic student watcher pid=$(cat "$LAB/logs/semantic-student-watch.pid") log=$LAB/logs/semantic-student-watch.log"
}

failure_rows() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo 0
    return 0
  fi
  FRAMECULL_FAILURES="$file" "$PY" - <<'PY'
import csv
import os
from pathlib import Path

path = Path(os.environ["FRAMECULL_FAILURES"])
if not path.exists():
    print(0)
    raise SystemExit(0)
with path.open("r", encoding="utf-8", newline="") as handle:
    reader = csv.DictReader(handle)
    print(sum(1 for _ in reader))
PY
}

retry_failures_if_any() {
  local label="$1"
  local mode="$2"
  local failures="$3"
  local log="$4"
  local count
  count="$(failure_rows "$failures")"
  if [[ "$count" -le 0 ]]; then
    echo "[watch] $label has no failures to replay"
    return 0
  fi
  echo "[watch] replaying $label failures count=$count with --resume"
  "$WORKSPACE/tools/pro-train/run_semantic_teacher_server.sh" "$mode" >> "$log" 2>&1
  local after
  after="$(failure_rows "$failures")"
  echo "[watch] $label replay finished remaining_failures=$after"
}

wait_for_teacher_complete() {
  local label="$1"
  local mode="$2"
  local output="$3"
  local summary="$4"
  local log="$5"
  while [[ "$(completion_count "$output" "$summary")" -lt "$EXPECTED" ]]; do
    local completed
    completed="$(completion_count "$output" "$summary")"
    local lines
    lines="$(line_count "$output")"
    if teacher_running_for "$output" >/dev/null; then
      echo "[watch] $label running progress=$completed/$EXPECTED success_lines=$lines time=$(date -Is)"
    else
      echo "[watch][warn] $label not running before completion progress=$completed/$EXPECTED success_lines=$lines"
      launch_teacher "$mode" "$log"
    fi
    sleep "$SLEEP_SECONDS"
  done
}

EXPECTED="$(expected_count)"
echo "[watch] expected=$EXPECTED ground=$GROUND flat=$FLAT"

archive_stale_teacher_output_if_idle grounded "$GROUND" "$GROUND_SUMMARY" "$LAB/logs/semantic-teacher-grounded.log"
archive_stale_teacher_output_if_idle flat "$FLAT" "$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json" "$LAB/logs/semantic-teacher-flat.log"
sync_phase_outputs

wait_for_teacher_complete grounded grounded "$GROUND" "$GROUND_SUMMARY" "$LAB/logs/semantic-teacher-grounded.log"
retry_failures_if_any grounded grounded "$GROUND_FAILURES" "$LAB/logs/semantic-teacher-grounded.log"
GROUND_LINES="$(line_count "$GROUND")"
GROUND_COMPLETED="$(completion_count "$GROUND" "$GROUND_SUMMARY")"
echo "[watch] grounded stopped progress=$GROUND_COMPLETED/$EXPECTED success_lines=$GROUND_LINES"

"$PY" tools/pro-train/semantic_teacher_schema.py "$GROUND"
"$PY" tools/pro-train/audit_semantic_teacher.py \
  --teacher "$GROUND" \
  --out "$LAB/outputs/semantic-teacher-lab/teacher-qa-grounded-full"
sync_phase_outputs

# Grounded QA is enough for the semantic-student watcher to start its grounded
# train/export/eval path while this watcher continues into flat-scalar teacher.
# The student watcher will block on flat completion later by itself.
launch_student_watch

if [[ "$(completion_count "$FLAT" "$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json")" -ge "$EXPECTED" ]]; then
  echo "[watch] flat already complete, validating"
  retry_failures_if_any flat flat "$FLAT_FAILURES" "$FLAT_LOG"
  "$PY" tools/pro-train/semantic_teacher_schema.py "$FLAT" --allow-flat-scalar
  "$PY" tools/pro-train/audit_semantic_teacher.py \
    --teacher "$FLAT" \
    --out "$LAB/outputs/semantic-teacher-lab/teacher-qa-flat-full" \
    --flat-scalar
  sync_phase_outputs
  launch_student_watch
  exit 0
fi

wait_for_teacher_complete flat flat "$FLAT" "$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json" "$FLAT_LOG"
retry_failures_if_any flat flat "$FLAT_FAILURES" "$FLAT_LOG"
FLAT_LINES="$(line_count "$FLAT")"
FLAT_COMPLETED="$(completion_count "$FLAT" "$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json")"
echo "[watch] flat stopped progress=$FLAT_COMPLETED/$EXPECTED success_lines=$FLAT_LINES"

"$PY" tools/pro-train/semantic_teacher_schema.py "$FLAT" --allow-flat-scalar
"$PY" tools/pro-train/audit_semantic_teacher.py \
  --teacher "$FLAT" \
  --out "$LAB/outputs/semantic-teacher-lab/teacher-qa-flat-full" \
  --flat-scalar
sync_phase_outputs

launch_student_watch

echo "[watch] semantic teacher grounded+flat pipeline complete"
