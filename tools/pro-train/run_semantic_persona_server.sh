#!/usr/bin/env bash
# Train a persona head on top of a Semantic Student V2 checkpoint.
# Usage:
#   run_semantic_persona_server.sh grounded
#   run_semantic_persona_server.sh flat

set -euo pipefail

MODE="${1:-grounded}"
LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
EPOCHS="${FRAMECULL_PERSONA_EPOCHS:-80}"
BATCH="${FRAMECULL_PERSONA_BATCH:-256}"
IMAGE_BATCH="${FRAMECULL_PERSONA_IMAGE_BATCH:-64}"
WORKERS="${FRAMECULL_PERSONA_WORKERS:-8}"
LIMIT="${FRAMECULL_PERSONA_LIMIT:-}"
SPLIT="${FRAMECULL_PERSONA_SPLIT:-stratified}"
CUSTOM_STUDENT="${FRAMECULL_PERSONA_STUDENT:-}"
CUSTOM_OUT="${FRAMECULL_PERSONA_OUT:-}"

case "$MODE" in
  grounded)
    STUDENT="${CUSTOM_STUDENT:-$LAB/outputs/semantic-student/grounded-convnext/student-best.pt}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/semantic-student/grounded-convnext-persona}"
    ;;
  flat)
    STUDENT="${CUSTOM_STUDENT:-$LAB/outputs/semantic-student/flat-convnext/student-best.pt}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/semantic-student/flat-convnext-persona}"
    ;;
  *)
    echo "Usage: $0 grounded|flat" >&2
    exit 2
    ;;
esac

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

mkdir -p "$OUT" "$LAB/tmp"
cd "$WORKSPACE"

if [[ ! -s "$STUDENT" ]]; then
  echo "Missing semantic student checkpoint: $STUDENT" >&2
  exit 1
fi

ARGS=(
  tools/pro-train/train_persona_head.py
  --student "$STUDENT"
  --out "$OUT"
  --split "$SPLIT"
  --epochs "$EPOCHS"
  --batch "$BATCH"
  --image-batch "$IMAGE_BATCH"
  --workers "$WORKERS"
)

if [[ -n "$LIMIT" ]]; then
  ARGS+=(--limit "$LIMIT")
fi

echo "[semantic-persona-server] mode=$MODE student=$STUDENT out=$OUT split=$SPLIT epochs=$EPOCHS batch=$BATCH image_batch=$IMAGE_BATCH"
"$PY" "${ARGS[@]}"
