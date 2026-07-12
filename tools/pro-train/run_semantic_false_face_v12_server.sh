#!/usr/bin/env bash
# Run the v12 student-only false-face retrain/eval path.
#
# This intentionally keeps the teacher prompt, teacher labels, backbone, and
# full 5167-image eval口径 identical to v11. Only the student distillation
# transmission changes: independent falseFaceRisk head, hard-negative weighting,
# and targeted high-risk scene oversampling.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"

MERGED_TEACHER="${FRAMECULL_FALSE_FACE_MERGED_TEACHER:-$LAB/features/semantic-teacher/semantic-teacher-v1.1-merged.jsonl}"
MERGE_REPORT="${FRAMECULL_FALSE_FACE_MERGE_REPORT:-$LAB/features/semantic-teacher/semantic-teacher-v1.1-merge-report.json}"
EXPECTED_SHA="${FRAMECULL_FALSE_FACE_TEACHER_SHA:-04f5527f8bc6922a743d20cefd5b537c6cf87882d119d20581b2b81985c62059}"

STUDENT_OUT="${FRAMECULL_FALSE_FACE_STUDENT_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v12-student-false-face}"
PERSONA_OUT="${FRAMECULL_FALSE_FACE_PERSONA_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v12-student-false-face-persona}"
EXPORT_OUT="${FRAMECULL_FALSE_FACE_EXPORT_OUT:-$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext_v12_student_false_face}"
EVAL_OUT="${FRAMECULL_FALSE_FACE_EVAL_OUT:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded-v12-student-false-face}"

LOCAL_DIAG="${FRAMECULL_FALSE_FACE_LOCAL_DIAG:-$WORKSPACE/output/semantic-false-face-diagnosis}"
LOCAL_V12="$LOCAL_DIAG/v12-student"
BASELINE_LOCAL_MERGED="$LOCAL_DIAG/semantic-teacher-v1.1-merged.jsonl"
BASELINE_LOCAL_REPORT="$LOCAL_DIAG/semantic-teacher-v1.1-merge-report.json"

export HF_HOME="$LAB/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$LAB/cache/huggingface"
export TORCH_HOME="$LAB/cache/torch"
export XDG_CACHE_HOME="$LAB/cache/xdg"
export TMPDIR="$LAB/tmp"
export PYTHONPATH="$WORKSPACE/tools/pro-train"

mkdir -p "$LAB/tmp" "$LAB/logs" "$(dirname "$MERGED_TEACHER")" "$(dirname "$MERGE_REPORT")" "$LOCAL_V12"
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

actual_sha="$(sha256sum "$MERGED_TEACHER" | awk '{print $1}')"
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  echo "Merged teacher SHA mismatch: expected=$EXPECTED_SHA actual=$actual_sha path=$MERGED_TEACHER" >&2
  exit 1
fi

echo "[false-face-v12] merged_teacher=$MERGED_TEACHER sha=$actual_sha"
echo "[false-face-v12] student_out=$STUDENT_OUT"
echo "[false-face-v12] persona_out=$PERSONA_OUT"
echo "[false-face-v12] export_out=$EXPORT_OUT"
echo "[false-face-v12] eval_out=$EVAL_OUT"

FRAMECULL_SEMANTIC_TEACHER="$MERGED_TEACHER" \
FRAMECULL_STUDENT_OUT="$STUDENT_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_student_server.sh" grounded

cp "$STUDENT_OUT/transmission-diagnosis.md" "$LOCAL_V12/transmission-diagnosis.md"
cp "$STUDENT_OUT/training-report.json" "$LOCAL_V12/training-report-v12.json"

FRAMECULL_PERSONA_STUDENT="$STUDENT_OUT/student-best.pt" \
FRAMECULL_PERSONA_OUT="$PERSONA_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_persona_server.sh" grounded

FRAMECULL_EXPORT_STUDENT="$STUDENT_OUT/student-best.pt" \
FRAMECULL_EXPORT_PERSONA="$PERSONA_OUT/persona-head.pt" \
FRAMECULL_EXPORT_OUT="$EXPORT_OUT" \
FRAMECULL_EXPORT_NAME="framecull-pro-semantic-v2-grounded-convnext-v12-student-false-face" \
"$WORKSPACE/tools/pro-train/run_semantic_export_server.sh" grounded

FRAMECULL_EVAL_MANIFEST="$EXPORT_OUT/manifest.int8.json" \
FRAMECULL_EVAL_OUT="$EVAL_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_eval_server.sh" grounded

cp "$EVAL_OUT/metrics-by-scene.csv" "$LOCAL_V12/metrics-by-scene.csv"
cp "$EVAL_OUT/metrics-by-ratio.csv" "$LOCAL_V12/metrics-by-ratio.csv"
cp "$EVAL_OUT/false-face-samples.csv" "$LOCAL_V12/false-face-samples.csv"
cp "$EVAL_OUT/summary.md" "$LOCAL_V12/summary.md"

node tools/ai-lab/write-false-face-v12-closure.mjs \
  --output "$LOCAL_V12" \
  --v12-scene "$LOCAL_V12/metrics-by-scene.csv" \
  --v12-ratio "$LOCAL_V12/metrics-by-ratio.csv"

echo "[false-face-v12] complete"
