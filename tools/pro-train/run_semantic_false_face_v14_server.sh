#!/usr/bin/env bash
# Run the Five Mountain v14 semantic student pipeline.
#
# v14 keeps the v13 independent holdout excluded, merges Five Mountain after
# dedupe, trains the semantic student with crop-level false-face region
# supervision, then runs recall and independent false-face evaluations.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"

V14_OUT="${FRAMECULL_V14_OUT:-$LAB/outputs/semantic-false-face-diagnosis/v14}"
BASE_TEACHER="${FRAMECULL_V14_BASE_TEACHER:-$LAB/features/semantic-teacher/semantic-teacher-v1.1-merged.jsonl}"
FIVE_TEACHER="${FRAMECULL_V14_FIVE_TEACHER:-$LAB/features/semantic-teacher/five-mountain-grounded.jsonl}"
MERGED_TEACHER="${FRAMECULL_V14_MERGED_TEACHER:-$LAB/features/semantic-teacher/semantic-teacher-v1.3-five-mountain-v14.jsonl}"
EXPECTED_BASE_SHA="${FRAMECULL_V14_EXPECTED_BASE_SHA:-04f5527f8bc6922a743d20cefd5b537c6cf87882d119d20581b2b81985c62059}"

INDEPENDENT_SET="${FRAMECULL_V14_INDEPENDENT_SET:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/independent-false-face-set.csv}"
OVERLAP_CHECK="${FRAMECULL_V14_OVERLAP_CHECK:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/overlap-check.json}"
INDEPENDENT_AUDIT="${FRAMECULL_V14_INDEPENDENT_AUDIT:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/independent-v13-audit.json}"
HOLDOUT_PREVIEW_DIR="${FRAMECULL_V14_HOLDOUT_PREVIEW_DIR:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/upload-previews-384}"
V12_RAW="${FRAMECULL_V14_V12_RAW:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/v12-generalization-raw.json}"
V13_RAW="${FRAMECULL_V14_V13_RAW:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/v13-generalization-raw.json}"
V12_RATIO_METRICS="${FRAMECULL_V14_V12_RATIO_METRICS:-$WORKSPACE/output/semantic-false-face-diagnosis/v12-student/metrics-by-ratio.csv}"
V13_RATIO_METRICS="${FRAMECULL_V14_V13_RATIO_METRICS:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/metrics-by-ratio.v13.csv}"

STUDENT_OUT="${FRAMECULL_V14_STUDENT_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v14-five-mountain-region}"
PERSONA_OUT="${FRAMECULL_V14_PERSONA_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v14-five-mountain-region-persona}"
EXPORT_OUT="${FRAMECULL_V14_EXPORT_OUT:-$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext_v14_five_mountain_region}"
EXPORT_NAME="${FRAMECULL_V14_EXPORT_NAME:-framecull-pro-semantic-v2-grounded-convnext-v14-five-mountain-region}"
EVAL_OUT="${FRAMECULL_V14_EVAL_OUT:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded-v14-five-mountain-region}"
V14_RAW="${FRAMECULL_V14_RAW:-$V14_OUT/v14-generalization-raw.json}"

BACKBONE="${FRAMECULL_STUDENT_BACKBONE:-convnext_tiny}"
EPOCHS="${FRAMECULL_STUDENT_EPOCHS:-30}"
BATCH="${FRAMECULL_STUDENT_BATCH:-64}"
MIN_BATCH="${FRAMECULL_STUDENT_MIN_BATCH:-8}"
WORKERS="${FRAMECULL_STUDENT_WORKERS:-8}"
REGION_BATCH="${FRAMECULL_V14_REGION_BATCH:-32}"
REGION_WEIGHT="${FRAMECULL_V14_REGION_WEIGHT:-1.5}"
PERSONA_EPOCHS="${FRAMECULL_PERSONA_EPOCHS:-80}"
PERSONA_BATCH="${FRAMECULL_PERSONA_BATCH:-256}"
PERSONA_IMAGE_BATCH="${FRAMECULL_PERSONA_IMAGE_BATCH:-64}"

export HF_HOME="$LAB/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$LAB/cache/huggingface"
export TORCH_HOME="$LAB/cache/torch"
export XDG_CACHE_HOME="$LAB/cache/xdg"
export TMPDIR="$LAB/tmp"
export PYTHONPATH="$WORKSPACE/tools/pro-train"
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export HTTP_PROXY="${HTTP_PROXY:-socks5h://127.0.0.1:10808}"
export HTTPS_PROXY="${HTTPS_PROXY:-socks5h://127.0.0.1:10808}"
export ALL_PROXY="${ALL_PROXY:-socks5h://127.0.0.1:10808}"

mkdir -p "$V14_OUT" "$STUDENT_OUT" "$PERSONA_OUT" "$EXPORT_OUT" "$EVAL_OUT" "$LAB/tmp"
cd "$WORKSPACE"

echo "[false-face-v14] prepare inventory + merged teacher"
"$PY" tools/pro-train/five_mountain_v14_prepare.py \
  --base-teacher "$BASE_TEACHER" \
  --five-teacher "$FIVE_TEACHER" \
  --holdout-csv "$INDEPENDENT_SET" \
  --out-dir "$V14_OUT" \
  --merged-teacher "$MERGED_TEACHER" \
  --expected-base-sha256 "$EXPECTED_BASE_SHA"

MERGED_SHA="$("$PY" - "$MERGED_TEACHER" <<'PY'
import hashlib, sys
path = sys.argv[1]
h = hashlib.sha256()
with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1024*1024), b''):
        h.update(chunk)
print(h.hexdigest())
PY
)"
echo "[false-face-v14] merged teacher sha=$MERGED_SHA"

"$PY" tools/pro-train/semantic_teacher_schema.py "$MERGED_TEACHER"

STUDENT_ARGS=(
  tools/pro-train/train_semantic_student.py
  --semantic-teacher "$MERGED_TEACHER"
  --expected-teacher-sha256 "$MERGED_SHA"
  --quality-teacher-dir "$LAB/features/teacher"
  --camera-previews "$LAB/incoming/camera-previews-384"
  --audit-previews "$LAB/incoming/raw-audit-previews"
  --five-mountain-previews "$LAB/incoming/five-mountain-previews-384"
  --include-five-mountain
  --strict-dataset-match
  --enable-region-supervision
  --w-region-face "$REGION_WEIGHT"
  --region-batch "$REGION_BATCH"
  --out "$STUDENT_OUT"
  --backbone "$BACKBONE"
  --epochs "$EPOCHS"
  --workers "$WORKERS"
)

run_student_once() {
  local batch="$1"
  local attempt_log="$STUDENT_OUT/train-attempt-batch${batch}.log"
  echo "[false-face-v14] train student batch=$batch epochs=$EPOCHS workers=$WORKERS region_batch=$REGION_BATCH"
  set +e
  "$PY" "${STUDENT_ARGS[@]}" --batch "$batch" 2>&1 | tee "$attempt_log"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

current_batch="$BATCH"
while true; do
  if run_student_once "$current_batch"; then
    break
  fi
  attempt_log="$STUDENT_OUT/train-attempt-batch${current_batch}.log"
  if [[ "$current_batch" -le "$MIN_BATCH" ]]; then
    echo "[false-face-v14][error] student training failed at minimum batch=$current_batch" >&2
    exit 1
  fi
  if ! grep -qi "CUDA out of memory" "$attempt_log"; then
    echo "[false-face-v14][error] student training failed for non-OOM reason; see $attempt_log" >&2
    exit 1
  fi
  next_batch=$(( current_batch / 2 ))
  if [[ "$next_batch" -lt "$MIN_BATCH" ]]; then next_batch="$MIN_BATCH"; fi
  echo "[false-face-v14][warn] CUDA OOM at batch=$current_batch; retrying with batch=$next_batch" >&2
  current_batch="$next_batch"
done

cp "$STUDENT_OUT/training-report.json" "$V14_OUT/training-report-v14.json"

echo "[false-face-v14] train persona head with Five Mountain, excluding independent holdout"
"$PY" tools/pro-train/train_persona_head.py \
  --student "$STUDENT_OUT/student-best.pt" \
  --out "$PERSONA_OUT" \
  --split stratified \
  --epochs "$PERSONA_EPOCHS" \
  --batch "$PERSONA_BATCH" \
  --image-batch "$PERSONA_IMAGE_BATCH" \
  --workers "$WORKERS" \
  --include-five-mountain \
  --source-balanced-weights \
  --exclude-photoids-csv "$INDEPENDENT_SET"

echo "[false-face-v14] export ONNX"
"$PY" tools/pro-train/export_pro_semantic_onnx.py \
  --student "$STUDENT_OUT/student-best.pt" \
  --persona "$PERSONA_OUT/persona-head.pt" \
  --out "$EXPORT_OUT" \
  --name "$EXPORT_NAME"

echo "[false-face-v14] full recall eval including Five Mountain"
FRAMECULL_EVAL_MANIFEST="$EXPORT_OUT/manifest.int8.json" \
FRAMECULL_EVAL_OUT="$EVAL_OUT" \
FRAMECULL_EVAL_INCLUDE_FIVE_MOUNTAIN=true \
"$WORKSPACE/tools/pro-train/run_semantic_eval_server.sh" grounded

cp "$EVAL_OUT/summary.md" "$V14_OUT/recall-report-v14.md"
cp "$EVAL_OUT/metrics-by-ratio.csv" "$V14_OUT/metrics-by-ratio.v14.csv"
cp "$EVAL_OUT/metrics-by-scene.csv" "$V14_OUT/metrics-by-scene.v14.csv"
cp "$EVAL_OUT/pro-infer-latency.csv" "$V14_OUT/pro-infer-latency.v14.csv"

echo "[false-face-v14] independent holdout inference"
"$PY" tools/pro-train/run_pro_semantic_onnx_infer.py \
  --audit "$INDEPENDENT_AUDIT" \
  --manifest "$EXPORT_OUT/manifest.int8.json" \
  --output "$V14_RAW" \
  --preview-dir "$HOLDOUT_PREVIEW_DIR" \
  --batch-size 8 \
  --provider auto

echo "[false-face-v14] write v13-style current report"
"$PY" tools/pro-train/write_false_face_generalization_v13.py \
  --independent-set "$INDEPENDENT_SET" \
  --raw "$V14_RAW" \
  --overlap-check "$OVERLAP_CHECK" \
  --output-dir "$V14_OUT" \
  --model-label "v14 区域监督独立头" \
  --scores-name "v14-generalization-scores.csv" \
  --summary-name "v14-generalization-summary.json" \
  --report-name "false-face-generalization-report-v14.md" \
  --raw-copy-name "v14-generalization-raw.json" \
  --baseline-raw "$V13_RAW" \
  --baseline-label "v13 独立头" \
  --v12-ratio-metrics "$V13_RATIO_METRICS" \
  --v13-ratio-metrics "$V14_OUT/metrics-by-ratio.v14.csv"

cat > "$V14_OUT/v14-pipeline-complete.json" <<JSON
{
  "schemaVersion": "framecull-false-face-v14-pipeline-complete-v1",
  "mergedTeacher": "$MERGED_TEACHER",
  "mergedTeacherSha256": "$MERGED_SHA",
  "studentOut": "$STUDENT_OUT",
  "personaOut": "$PERSONA_OUT",
  "exportOut": "$EXPORT_OUT",
  "evalOut": "$EVAL_OUT",
  "v14Out": "$V14_OUT"
}
JSON

echo "[false-face-v14] complete -> $V14_OUT"
