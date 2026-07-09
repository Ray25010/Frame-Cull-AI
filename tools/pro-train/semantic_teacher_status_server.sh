#!/usr/bin/env bash
# Read-only status helper for Semantic Teacher Lab server jobs.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"

echo "== time =="
date

echo
echo "== teacher outputs =="
for name in semantic-teacher-v1 semantic-teacher-v1-flat; do
  file="$LAB/features/semantic-teacher/$name.jsonl"
  summary="$LAB/features/semantic-teacher/$name.summary.json"
  if [[ -f "$file" ]]; then
    printf "%s lines: " "$name"
    wc -l "$file"
  else
    echo "$name lines: missing"
  fi
  if [[ -f "$summary" ]]; then
    echo "$name summary:"
    cat "$summary"
  fi
done

echo
echo "== progress estimate =="
FRAMECULL_LAB="$LAB" python3 - <<'PY' || true
import json
import os
import subprocess
from pathlib import Path

lab = Path(os.environ.get("FRAMECULL_LAB", "/data/FrameCullModelLab"))
phase0 = lab / "outputs/semantic-teacher-lab/phase0/all-images.json"
try:
    expected = len(json.loads(phase0.read_text()))
except Exception:
    expected = 0

def inspect_lineage(output: Path, summary: Path) -> dict:
    cmd = [
        "python3",
        str(lab / "workspace" / "tools" / "pro-train" / "inspect_teacher_lineage.py"),
        "--input",
        str(phase0),
        "--output",
        str(output),
        "--summary",
        str(summary),
    ]
    return json.loads(subprocess.check_output(cmd, text=True))

for label, output, log in [
    ("grounded", lab / "features/semantic-teacher/semantic-teacher-v1.jsonl", lab / "logs/semantic-teacher-grounded.log"),
    ("flat", lab / "features/semantic-teacher/semantic-teacher-v1-flat.jsonl", lab / "logs/semantic-teacher-flat.log"),
]:
    summary = output.with_suffix(".summary.json")
    lineage = inspect_lineage(output, summary)
    lines = int((lineage.get("output") or {}).get("lineCount") or 0)
    unique_rows = int((lineage.get("output") or {}).get("uniqueRows") or 0)
    completed = int(lineage.get("progress") or 0)
    notes = [str(lineage.get("reason") or "unknown")]
    summary_state = lineage.get("summary") or {}
    if summary_state.get("resumeSafe"):
        notes = ["summary-ok"]
    elif (lineage.get("output") or {}).get("resumeSafe"):
        notes = ["output-only-resume-safe"]
    if lines <= 0:
        print(f"{label}: {completed}/{expected or '?'} progress, {lines} success lines, no rate yet, {'; '.join(notes)}")
    else:
        print(f"{label}: {completed}/{expected or '?'} progress, {lines} success lines, unique={unique_rows}, {'; '.join(notes)}")
PY

echo
echo "== jobs =="
ps -eo pid,ppid,stat,etime,cmd | grep -E "run_semantic_teacher.py|run_semantic_teacher_server.sh|train_semantic_student.py|export_pro_semantic_onnx.py" | grep -v grep || true

echo
echo "== gpu =="
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits || true

echo
echo "== grounded log tail =="
tail -n 30 "$LAB/logs/semantic-teacher-grounded.log" 2>/dev/null || true

echo
echo "== flat log tail =="
tail -n 30 "$LAB/logs/semantic-teacher-flat.log" 2>/dev/null || true
