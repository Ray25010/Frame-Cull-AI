#!/usr/bin/env bash
# Run the false-face v1.1 grounded retrain/eval path from a merged teacher patch.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"

MERGED_TEACHER="${FRAMECULL_FALSE_FACE_MERGED_TEACHER:-$LAB/features/semantic-teacher/semantic-teacher-v1.1-merged.jsonl}"
MERGE_REPORT="${FRAMECULL_FALSE_FACE_MERGE_REPORT:-$LAB/features/semantic-teacher/semantic-teacher-v1.1-merge-report.json}"
STUDENT_OUT="${FRAMECULL_FALSE_FACE_STUDENT_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v11-false-face}"
PERSONA_OUT="${FRAMECULL_FALSE_FACE_PERSONA_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v11-false-face-persona}"
EXPORT_OUT="${FRAMECULL_FALSE_FACE_EXPORT_OUT:-$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext_v11_false_face}"
EVAL_OUT="${FRAMECULL_FALSE_FACE_EVAL_OUT:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded-v11-false-face}"

BASELINE_LOCAL_DIAG="${FRAMECULL_FALSE_FACE_LOCAL_DIAG:-$WORKSPACE/output/semantic-false-face-diagnosis}"
BASELINE_LOCAL_MERGED="$BASELINE_LOCAL_DIAG/semantic-teacher-v1.1-merged.jsonl"
BASELINE_LOCAL_REPORT="$BASELINE_LOCAL_DIAG/semantic-teacher-v1.1-merge-report.json"
BASELINE_REMOTE_GROUNDED="$LAB/features/semantic-teacher/semantic-teacher-v1.jsonl"

export HF_HOME="$LAB/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$LAB/cache/huggingface"
export TORCH_HOME="$LAB/cache/torch"
export XDG_CACHE_HOME="$LAB/cache/xdg"
export TMPDIR="$LAB/tmp"
export PYTHONPATH="$WORKSPACE/tools/pro-train"

mkdir -p "$LAB/tmp" "$LAB/logs" "$(dirname "$MERGED_TEACHER")" "$(dirname "$MERGE_REPORT")"
cd "$WORKSPACE"

if [[ ! -s "$MERGED_TEACHER" ]]; then
  if [[ ! -s "$BASELINE_LOCAL_MERGED" ]]; then
    echo "Missing merged teacher source: $BASELINE_LOCAL_MERGED" >&2
    exit 1
  fi
  cp "$BASELINE_LOCAL_MERGED" "$MERGED_TEACHER"
fi

if [[ ! -s "$MERGE_REPORT" && -s "$BASELINE_LOCAL_REPORT" ]]; then
  cp "$BASELINE_LOCAL_REPORT" "$MERGE_REPORT"
fi

if [[ ! -s "$MERGED_TEACHER" ]]; then
  echo "Merged teacher not ready: $MERGED_TEACHER" >&2
  exit 1
fi

echo "[false-face-v11] merged_teacher=$MERGED_TEACHER"
echo "[false-face-v11] student_out=$STUDENT_OUT"
echo "[false-face-v11] persona_out=$PERSONA_OUT"
echo "[false-face-v11] export_out=$EXPORT_OUT"
echo "[false-face-v11] eval_out=$EVAL_OUT"

FRAMECULL_SEMANTIC_TEACHER="$MERGED_TEACHER" \
FRAMECULL_STUDENT_OUT="$STUDENT_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_student_server.sh" grounded

FRAMECULL_PERSONA_STUDENT="$STUDENT_OUT/student-best.pt" \
FRAMECULL_PERSONA_OUT="$PERSONA_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_persona_server.sh" grounded

FRAMECULL_EXPORT_STUDENT="$STUDENT_OUT/student-best.pt" \
FRAMECULL_EXPORT_PERSONA="$PERSONA_OUT/persona-head.pt" \
FRAMECULL_EXPORT_OUT="$EXPORT_OUT" \
FRAMECULL_EXPORT_NAME="framecull-pro-semantic-v2-grounded-convnext-v11-false-face" \
"$WORKSPACE/tools/pro-train/run_semantic_export_server.sh" grounded

FRAMECULL_EVAL_MANIFEST="$EXPORT_OUT/manifest.int8.json" \
FRAMECULL_EVAL_OUT="$EVAL_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_eval_server.sh" grounded

echo "[false-face-v11] complete"
