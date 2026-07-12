#!/usr/bin/env bash
set -euo pipefail
LAB=/data/FrameCullModelLab
WORKSPACE=$LAB/workspace
LOG=$LAB/logs/grounded-export-eval.log
STUDENT=$LAB/outputs/semantic-student/grounded-convnext/student-best.pt
PERSONA=$LAB/outputs/semantic-student/grounded-convnext-persona/persona-head.pt
MANIFEST=$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext/manifest.int8.json
OUT_SUMMARY=$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded/summary.md
RATIO_CONFIG=$WORKSPACE/output/ai-bench/ratio-aware-ai-picks/selected-config-by-ratio.json
mkdir -p "$LAB/logs"
cd "$WORKSPACE"
{
  echo "[grounded-chain] start $(date -Is)"
  while [[ ! -s "$STUDENT" ]]; do
    echo "[grounded-chain] waiting student-best $(date -Is)"
    sleep 60
  done

  while pgrep -f "train_semantic_student.py.*grounded-convnext|run_semantic_student_server.sh grounded" >/dev/null; do
    echo "[grounded-chain] waiting grounded training to exit $(date -Is)"
    sleep 120
  done

  first_size="$(stat -c '%s' "$STUDENT")"
  sleep 30
  second_size="$(stat -c '%s' "$STUDENT")"
  if [[ "$first_size" != "$second_size" ]]; then
    echo "[grounded-chain] checkpoint still changing size=$first_size->$second_size $(date -Is)"
    sleep 120
  fi

  if [[ ! -s "$RATIO_CONFIG" ]]; then
    echo "[grounded-chain] missing ratio-aware config: $RATIO_CONFIG" >&2
    exit 1
  fi

  echo "[grounded-chain] student-ready $(date -Is)"
  if [[ ! -s "$MANIFEST" || "$STUDENT" -nt "$MANIFEST" || ( -s "$PERSONA" && "$PERSONA" -nt "$MANIFEST" ) ]]; then
    bash tools/pro-train/run_semantic_export_server.sh grounded
  else
    echo "[grounded-chain] export already exists"
  fi
  if [[ ! -s "$OUT_SUMMARY" || "$MANIFEST" -nt "$OUT_SUMMARY" || ( -s "$PERSONA" && "$PERSONA" -nt "$OUT_SUMMARY" ) ]]; then
    bash tools/pro-train/run_semantic_eval_server.sh grounded
  else
    echo "[grounded-chain] eval already exists"
  fi
  echo "[grounded-chain] done $(date -Is)"
} >> "$LOG" 2>&1
