#!/usr/bin/env bash
# Run full Semantic Student V2 ONNX inference + bench on the 5090 server.
# Usage:
#   run_semantic_eval_server.sh grounded
#   run_semantic_eval_server.sh flat

set -euo pipefail

MODE="${1:-grounded}"
LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
BATCH="${FRAMECULL_SEMANTIC_EVAL_BATCH:-8}"
LIMIT="${FRAMECULL_SEMANTIC_EVAL_LIMIT:-}"
CUSTOM_MANIFEST="${FRAMECULL_EVAL_MANIFEST:-}"
CUSTOM_OUT="${FRAMECULL_EVAL_OUT:-}"
CUSTOM_TEACHER_QA="${FRAMECULL_EVAL_TEACHER_QA:-}"
CUSTOM_FLAT_COMPARE="${FRAMECULL_EVAL_FLAT_COMPARE:-}"
INCLUDE_FIVE_MOUNTAIN="${FRAMECULL_EVAL_INCLUDE_FIVE_MOUNTAIN:-false}"

case "$MODE" in
  grounded)
    MANIFEST="${CUSTOM_MANIFEST:-$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext/manifest.int8.json}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded}"
    TEACHER_QA="${CUSTOM_TEACHER_QA:-$LAB/outputs/semantic-teacher-lab/teacher-qa-grounded-full/teacher-quality-report.md}"
    FLAT_COMPARE="${CUSTOM_FLAT_COMPARE:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-flat}"
    ;;
  flat)
    MANIFEST="${CUSTOM_MANIFEST:-$LAB/outputs/pro-models/semantic_student_v2_flat_convnext/manifest.int8.json}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/semantic-teacher-lab/eval-full/bench-flat}"
    TEACHER_QA="${CUSTOM_TEACHER_QA:-$LAB/outputs/semantic-teacher-lab/teacher-qa-flat-full/teacher-quality-report.md}"
    FLAT_COMPARE="${CUSTOM_FLAT_COMPARE:-}"
    ;;
  *)
    echo "Usage: $0 grounded|flat" >&2
    exit 2
    ;;
esac

LICENSE="$LAB/outputs/semantic-teacher-lab/teacher-license-clearance.md"
AUDIT="$WORKSPACE/output/ai-bench/ai-culling-bench-scene-aware-replay.json"
PHASE0="$LAB/outputs/semantic-teacher-lab/phase0/all-images.json"
PREVIEW_DIR="$LAB/incoming/raw-audit-previews"
EVAL_AUDIT="$OUT/ai-culling-bench-pro-semantic-eval-input.json"
EVAL_LABELS="$OUT/pro-semantic-eval-labels.json"
EVAL_META="$OUT/pro-semantic-eval-input-meta.json"
INFER_JSON="$OUT/pro-infer-latency.json"
BASELINE_PERSONA_INFER_WORKSPACE="$WORKSPACE/output/ai-bench/pro-persona-eval/pro-infer-latency.json"
BASELINE_PERSONA_INFER_LAB="$LAB/outputs/pro-persona-eval/pro-infer-latency.json"

export HF_HOME="$LAB/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$LAB/cache/huggingface"
export TORCH_HOME="$LAB/cache/torch"
export XDG_CACHE_HOME="$LAB/cache/xdg"
export TMPDIR="$LAB/tmp"
export PYTHONPATH="$WORKSPACE/tools/pro-train"

mkdir -p "$OUT" "$LAB/tmp"
cd "$WORKSPACE"

if [[ ! -s "$MANIFEST" ]]; then
  echo "Missing semantic student manifest: $MANIFEST" >&2
  exit 1
fi

if [[ ! -s "$TEACHER_QA" ]]; then
  echo "Missing teacher QA report: $TEACHER_QA" >&2
  exit 1
fi

if [[ ! -s "$LICENSE" ]]; then
  echo "Missing teacher license report: $LICENSE" >&2
  exit 1
fi

echo "[semantic-eval-server] mode=$MODE manifest=$MANIFEST out=$OUT batch=$BATCH"

node tools/ai-lab/build-pro-semantic-eval-audit.mjs \
  --audit3groups-audit "$AUDIT" \
  --phase0-all-images "$PHASE0" \
  --output "$EVAL_AUDIT" \
  --labels-output "$EVAL_LABELS" \
  --meta-output "$EVAL_META" \
  --include-camera true \
  --include-five-mountain "$INCLUDE_FIVE_MOUNTAIN"

INFER_ARGS=(
  tools/pro-train/run_pro_semantic_onnx_infer.py
  --audit "$EVAL_AUDIT"
  --manifest "$MANIFEST"
  --output "$INFER_JSON"
  --preview-dir "$PREVIEW_DIR"
  --batch-size "$BATCH"
)
if [[ -n "$LIMIT" ]]; then
  INFER_ARGS+=(--limit "$LIMIT")
fi

"$PY" "${INFER_ARGS[@]}"

BENCH_ARGS=(
  tools/ai-lab/bench-pro-semantic-student.mjs
  --output "$OUT"
  --eval-audit "$EVAL_AUDIT"
  --eval-labels "$EVAL_LABELS"
  --eval-meta "$EVAL_META"
  --labels "$EVAL_LABELS"
  --preview-dir "$PREVIEW_DIR"
  --manifest "$MANIFEST"
  --infer-json "$INFER_JSON"
  --skip-infer true
  --build-eval-audit false
  --teacher-quality-report "$TEACHER_QA"
  --teacher-license-report "$LICENSE"
  --selected-config "$WORKSPACE/output/ai-bench/ratio-aware-ai-picks/selected-config-by-ratio.json"
  --dataset-label-policies '{"audit3groups":{"positiveThreshold":3,"negativeThreshold":0,"missingAsNegative":true},"camera":{"positiveThreshold":1,"negativeThreshold":0,"missingAsNegative":true},"five_mountain":{"positiveThreshold":1,"negativeThreshold":0,"missingAsNegative":true}}'
)
if [[ -n "$LIMIT" ]]; then
  BENCH_ARGS+=(--limit "$LIMIT")
fi
if [[ -n "$FLAT_COMPARE" ]]; then
  BENCH_ARGS+=(--flat-scalar-output "$FLAT_COMPARE")
fi
if [[ -s "$BASELINE_PERSONA_INFER_LAB" ]]; then
  BENCH_ARGS+=(--baseline-persona-infer-json "$BASELINE_PERSONA_INFER_LAB")
elif [[ -s "$BASELINE_PERSONA_INFER_WORKSPACE" ]]; then
  BENCH_ARGS+=(--baseline-persona-infer-json "$BASELINE_PERSONA_INFER_WORKSPACE")
fi

node "${BENCH_ARGS[@]}"

GROUND_DIR="$LAB/outputs/semantic-teacher-lab/eval-full/bench-grounded"
FLAT_DIR="$LAB/outputs/semantic-teacher-lab/eval-full/bench-flat"
if [[ -d "$GROUND_DIR" && -d "$FLAT_DIR" ]]; then
  node tools/ai-lab/write-pro-semantic-ablation.mjs \
    --grounded-output "$GROUND_DIR" \
    --flat-output "$FLAT_DIR" \
    --output "$GROUND_DIR/grounded-vs-flat-ablation.md" \
    --update-production-recommendation "$GROUND_DIR/production-recommendation.md"
  "$PY" tools/pro-train/verify_semantic_teacher_lab_outputs.py \
    --lab "$LAB" \
    --output-json "$GROUND_DIR/final-output-audit.json" \
    --output-md "$GROUND_DIR/final-output-audit.md"
fi
