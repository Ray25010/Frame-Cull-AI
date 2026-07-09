#!/usr/bin/env bash
# Run the Phase 3 false-face v13 retrain pipeline after human-confirmed shortlist.
#
# This script keeps the v13 holdout excluded from training, patches only
# confirmed hard negatives into the semantic teacher JSONL, retrains student
# only, exports ONNX, reruns the same independent holdout, and writes a
# v12-v13 comparison report with recall trade-off notes.

set -euo pipefail

LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"

LOCAL_V13_EVAL="${FRAMECULL_V13_LOCAL_EVAL:-$WORKSPACE/output/semantic-false-face-diagnosis/v13-eval}"
BASELINE_LOCAL_TEACHER="${FRAMECULL_V13_BASELINE_LOCAL_TEACHER:-$WORKSPACE/output/semantic-false-face-diagnosis/semantic-teacher-v1.1-merged.jsonl}"
CONFIRMED_SHORTLIST="${FRAMECULL_V13_CONFIRMED_SHORTLIST:-$LOCAL_V13_EVAL/phase3-hard-negative-shortlist.csv}"
HOLDOUT_IDS="${FRAMECULL_V13_HOLDOUT_IDS:-$LOCAL_V13_EVAL/v13-holdout-photoids.txt}"
INDEPENDENT_SET="${FRAMECULL_V13_INDEPENDENT_SET:-$LOCAL_V13_EVAL/independent-false-face-set.csv}"
OVERLAP_CHECK="${FRAMECULL_V13_OVERLAP_CHECK:-$LOCAL_V13_EVAL/overlap-check.json}"
INDEPENDENT_AUDIT="${FRAMECULL_V13_INDEPENDENT_AUDIT:-$LOCAL_V13_EVAL/independent-v13-audit.json}"
LOCAL_HOLDOUT_PREVIEW_DIR="${FRAMECULL_V13_HOLDOUT_PREVIEW_DIR:-$LOCAL_V13_EVAL/upload-previews-384}"
BASELINE_RAW="${FRAMECULL_V13_BASELINE_RAW:-$LOCAL_V13_EVAL/v12-generalization-raw.json}"
V12_RATIO_METRICS="${FRAMECULL_V13_V12_RATIO_METRICS:-$WORKSPACE/output/semantic-false-face-diagnosis/v12-student/metrics-by-ratio.csv}"

REMOTE_TEACHER_DIR="${FRAMECULL_V13_REMOTE_TEACHER_DIR:-$LAB/features/semantic-teacher}"
REMOTE_BASELINE_TEACHER="${FRAMECULL_V13_REMOTE_BASELINE_TEACHER:-$REMOTE_TEACHER_DIR/semantic-teacher-v1.1-merged.jsonl}"
REMOTE_PATCH_JSONL="${FRAMECULL_V13_REMOTE_PATCH_JSONL:-$REMOTE_TEACHER_DIR/semantic-teacher-v1.2-false-face-v13-patch.jsonl}"
REMOTE_PATCH_SUMMARY="${FRAMECULL_V13_REMOTE_PATCH_SUMMARY:-$REMOTE_TEACHER_DIR/semantic-teacher-v1.2-false-face-v13-patch.summary.json}"
REMOTE_MERGED_TEACHER="${FRAMECULL_V13_REMOTE_MERGED_TEACHER:-$REMOTE_TEACHER_DIR/semantic-teacher-v1.2-false-face-v13-merged.jsonl}"
REMOTE_MERGE_REPORT="${FRAMECULL_V13_REMOTE_MERGE_REPORT:-$REMOTE_TEACHER_DIR/semantic-teacher-v1.2-false-face-v13-merge-report.json}"

REMOTE_STUDENT_OUT="${FRAMECULL_V13_STUDENT_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v13-student-false-face}"
REMOTE_PERSONA_OUT="${FRAMECULL_V13_PERSONA_OUT:-$LAB/outputs/semantic-student/grounded-convnext-v13-student-false-face-persona}"
REMOTE_EXPORT_OUT="${FRAMECULL_V13_EXPORT_OUT:-$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext_v13_student_false_face}"
REMOTE_EXPORT_NAME="${FRAMECULL_V13_EXPORT_NAME:-framecull-pro-semantic-v2-grounded-convnext-v13-student-false-face}"
REMOTE_V13_HOLDOUT_RAW="${FRAMECULL_V13_HOLDOUT_RAW:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/v13-generalization-raw.json}"
REMOTE_V13_EVAL_OUT="${FRAMECULL_V13_EVAL_OUT:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded-v13-student-false-face}"
REMOTE_HOLDOUT_PREVIEW_DIR="${FRAMECULL_V13_REMOTE_HOLDOUT_PREVIEW_DIR:-$LAB/outputs/semantic-false-face-diagnosis/v13-eval/upload-previews-384}"

LOCAL_TRAINING_REPORT_OUT="${FRAMECULL_V13_LOCAL_TRAINING_REPORT:-$LOCAL_V13_EVAL/training-report-v13.json}"
LOCAL_PATCH_SUMMARY_OUT="${FRAMECULL_V13_LOCAL_PATCH_SUMMARY:-$LOCAL_V13_EVAL/phase3-hard-negative-patch.v13.summary.json}"
LOCAL_MERGE_REPORT_OUT="${FRAMECULL_V13_LOCAL_MERGE_REPORT:-$LOCAL_V13_EVAL/semantic-teacher-v1.2-false-face-v13-merge-report.json}"
LOCAL_V13_RATIO_METRICS="${FRAMECULL_V13_LOCAL_RATIO_METRICS:-$LOCAL_V13_EVAL/metrics-by-ratio.v13.csv}"
LOCAL_V13_SCENE_METRICS="${FRAMECULL_V13_LOCAL_SCENE_METRICS:-$LOCAL_V13_EVAL/metrics-by-scene.v13.csv}"
LOCAL_V13_EVAL_SUMMARY="${FRAMECULL_V13_LOCAL_EVAL_SUMMARY:-$LOCAL_V13_EVAL/summary-v13.md}"
LOCAL_V13_FALSE_FACE_SAMPLES="${FRAMECULL_V13_LOCAL_FALSE_FACE_SAMPLES:-$LOCAL_V13_EVAL/false-face-samples.v13.csv}"
LOCAL_V13_LATENCY="${FRAMECULL_V13_LOCAL_LATENCY:-$LOCAL_V13_EVAL/pro-infer-latency.v13.csv}"

export HF_HOME="$LAB/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$LAB/cache/huggingface"
export TORCH_HOME="$LAB/cache/torch"
export XDG_CACHE_HOME="$LAB/cache/xdg"
export TMPDIR="$LAB/tmp"
export PYTHONPATH="$WORKSPACE/tools/pro-train"

mkdir -p "$LAB/tmp" "$REMOTE_TEACHER_DIR" "$REMOTE_STUDENT_OUT" "$REMOTE_PERSONA_OUT" "$REMOTE_EXPORT_OUT" "$LOCAL_V13_EVAL"
cd "$WORKSPACE"

if [[ ! -s "$CONFIRMED_SHORTLIST" ]]; then
  echo "Missing confirmed shortlist: $CONFIRMED_SHORTLIST" >&2
  exit 1
fi
if [[ ! -s "$HOLDOUT_IDS" ]]; then
  echo "Missing holdout ids: $HOLDOUT_IDS" >&2
  exit 1
fi
if [[ ! -s "$INDEPENDENT_SET" ]]; then
  echo "Missing independent set: $INDEPENDENT_SET" >&2
  exit 1
fi
if [[ ! -s "$INDEPENDENT_AUDIT" ]]; then
  echo "Missing independent audit: $INDEPENDENT_AUDIT" >&2
  exit 1
fi
if [[ ! -d "$REMOTE_HOLDOUT_PREVIEW_DIR" ]]; then
  echo "Missing remote holdout preview dir: $REMOTE_HOLDOUT_PREVIEW_DIR" >&2
  exit 1
fi
if [[ ! -d "$LOCAL_HOLDOUT_PREVIEW_DIR" ]]; then
  echo "[false-face-v13][warn] local holdout preview dir missing, fallback to remote path: $REMOTE_HOLDOUT_PREVIEW_DIR" >&2
  LOCAL_HOLDOUT_PREVIEW_DIR="$REMOTE_HOLDOUT_PREVIEW_DIR"
fi

if [[ ! -s "$REMOTE_BASELINE_TEACHER" ]]; then
  if [[ ! -s "$BASELINE_LOCAL_TEACHER" ]]; then
    echo "Missing baseline teacher source: remote=$REMOTE_BASELINE_TEACHER local=$BASELINE_LOCAL_TEACHER" >&2
    exit 1
  fi
  cp "$BASELINE_LOCAL_TEACHER" "$REMOTE_BASELINE_TEACHER"
fi

echo "[false-face-v13] building teacher patch"
"$PY" tools/pro-train/build_false_face_v13_teacher_patch.py \
  --baseline-teacher "$REMOTE_BASELINE_TEACHER" \
  --confirmed-shortlist "$CONFIRMED_SHORTLIST" \
  --holdout-ids "$HOLDOUT_IDS" \
  --output-jsonl "$REMOTE_PATCH_JSONL" \
  --summary-json "$REMOTE_PATCH_SUMMARY"

PATCHED_ROWS="$("$PY" - "$REMOTE_PATCH_SUMMARY" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(int(payload.get("patchedRows", 0)))
PY
)"
if [[ "$PATCHED_ROWS" -le 0 ]]; then
  echo "[false-face-v13][error] patch summary shows 0 patched rows. Finish human review first: $CONFIRMED_SHORTLIST" >&2
  exit 1
fi

echo "[false-face-v13] merging patched teacher rows"
"$PY" tools/pro-train/merge_semantic_teacher_patch.py \
  --baseline "$REMOTE_BASELINE_TEACHER" \
  --patched "$REMOTE_PATCH_JSONL" \
  --out "$REMOTE_MERGED_TEACHER" \
  --report "$REMOTE_MERGE_REPORT"

MERGED_SHA="$("$PY" - "$REMOTE_MERGED_TEACHER" <<'PY'
import hashlib, sys
path = sys.argv[1]
h = hashlib.sha256()
with open(path, 'rb') as f:
    for chunk in iter(lambda: f.read(1024*1024), b''):
        h.update(chunk)
print(h.hexdigest())
PY
)"

echo "[false-face-v13] merged teacher sha=$MERGED_SHA"

FRAMECULL_SEMANTIC_TEACHER="$REMOTE_MERGED_TEACHER" \
FRAMECULL_STUDENT_OUT="$REMOTE_STUDENT_OUT" \
FRAMECULL_STUDENT_EXPECTED_TEACHER_SHA="$MERGED_SHA" \
"$WORKSPACE/tools/pro-train/run_semantic_student_server.sh" grounded

cp "$REMOTE_STUDENT_OUT/training-report.json" "$LOCAL_TRAINING_REPORT_OUT"

FRAMECULL_PERSONA_STUDENT="$REMOTE_STUDENT_OUT/student-best.pt" \
FRAMECULL_PERSONA_OUT="$REMOTE_PERSONA_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_persona_server.sh" grounded

FRAMECULL_EXPORT_STUDENT="$REMOTE_STUDENT_OUT/student-best.pt" \
FRAMECULL_EXPORT_PERSONA="$REMOTE_PERSONA_OUT/persona-head.pt" \
FRAMECULL_EXPORT_OUT="$REMOTE_EXPORT_OUT" \
FRAMECULL_EXPORT_NAME="$REMOTE_EXPORT_NAME" \
"$WORKSPACE/tools/pro-train/run_semantic_export_server.sh" grounded

echo "[false-face-v13] running full recall/bench eval"
FRAMECULL_EVAL_MANIFEST="$REMOTE_EXPORT_OUT/manifest.int8.json" \
FRAMECULL_EVAL_OUT="$REMOTE_V13_EVAL_OUT" \
"$WORKSPACE/tools/pro-train/run_semantic_eval_server.sh" grounded

cp "$REMOTE_V13_EVAL_OUT/metrics-by-ratio.csv" "$LOCAL_V13_RATIO_METRICS"
cp "$REMOTE_V13_EVAL_OUT/metrics-by-scene.csv" "$LOCAL_V13_SCENE_METRICS"
cp "$REMOTE_V13_EVAL_OUT/summary.md" "$LOCAL_V13_EVAL_SUMMARY"
cp "$REMOTE_V13_EVAL_OUT/false-face-samples.csv" "$LOCAL_V13_FALSE_FACE_SAMPLES"
cp "$REMOTE_V13_EVAL_OUT/pro-infer-latency.csv" "$LOCAL_V13_LATENCY"

echo "[false-face-v13] rerunning independent holdout"
"$PY" tools/pro-train/run_pro_semantic_onnx_infer.py \
  --audit "$INDEPENDENT_AUDIT" \
  --manifest "$REMOTE_EXPORT_OUT/manifest.int8.json" \
  --output "$REMOTE_V13_HOLDOUT_RAW" \
  --preview-dir "$REMOTE_HOLDOUT_PREVIEW_DIR" \
  --batch-size 8 \
  --provider auto

echo "[false-face-v13] writing comparison report"
"$PY" tools/pro-train/write_false_face_generalization_v13.py \
  --independent-set "$INDEPENDENT_SET" \
  --raw "$REMOTE_V13_HOLDOUT_RAW" \
  --overlap-check "$OVERLAP_CHECK" \
  --output-dir "$LOCAL_V13_EVAL" \
  --model-label "v13 独立头" \
  --scores-name "v13-generalization-scores.csv" \
  --summary-name "v13-generalization-summary.json" \
  --report-name "false-face-generalization-report.md" \
  --raw-copy-name "v13-generalization-raw.json" \
  --baseline-raw "$BASELINE_RAW" \
  --baseline-label "v12 独立头" \
  --v12-ratio-metrics "$V12_RATIO_METRICS" \
  --v13-ratio-metrics "$LOCAL_V13_RATIO_METRICS"

cp "$REMOTE_PATCH_SUMMARY" "$LOCAL_PATCH_SUMMARY_OUT"
cp "$REMOTE_MERGE_REPORT" "$LOCAL_MERGE_REPORT_OUT"

echo "[false-face-v13] complete"
