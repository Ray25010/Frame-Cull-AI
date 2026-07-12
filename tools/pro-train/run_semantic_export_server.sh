#!/usr/bin/env bash
# Export a trained Semantic Student V2 checkpoint to ONNX manifests.
# Usage:
#   run_semantic_export_server.sh grounded
#   run_semantic_export_server.sh flat

set -euo pipefail

MODE="${1:-grounded}"
LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
CUSTOM_STUDENT="${FRAMECULL_EXPORT_STUDENT:-}"
CUSTOM_PERSONA="${FRAMECULL_EXPORT_PERSONA:-}"
CUSTOM_OUT="${FRAMECULL_EXPORT_OUT:-}"
CUSTOM_NAME="${FRAMECULL_EXPORT_NAME:-}"

case "$MODE" in
  grounded)
    STUDENT="${CUSTOM_STUDENT:-$LAB/outputs/semantic-student/grounded-convnext/student-best.pt}"
    PERSONA="${CUSTOM_PERSONA:-$LAB/outputs/semantic-student/grounded-convnext-persona/persona-head.pt}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/pro-models/semantic_student_v2_grounded_convnext}"
    NAME="${CUSTOM_NAME:-framecull-pro-semantic-v2-grounded-convnext}"
    ;;
  flat)
    STUDENT="${CUSTOM_STUDENT:-$LAB/outputs/semantic-student/flat-convnext/student-best.pt}"
    PERSONA="${CUSTOM_PERSONA:-$LAB/outputs/semantic-student/flat-convnext-persona/persona-head.pt}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/pro-models/semantic_student_v2_flat_convnext}"
    NAME="${CUSTOM_NAME:-framecull-pro-semantic-v2-flat-convnext}"
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

mkdir -p "$OUT"
cd "$WORKSPACE"

if [[ ! -s "$STUDENT" ]]; then
  echo "Missing semantic student checkpoint: $STUDENT" >&2
  exit 1
fi

ARGS=(
  --student "$STUDENT"
  --out "$OUT"
  --name "$NAME"
)

if [[ -s "$PERSONA" ]]; then
  echo "[semantic-export-server] using persona head: $PERSONA"
  ARGS+=(--persona "$PERSONA")
else
  echo "[semantic-export-server] persona head not found, exporting semantic-only model"
fi

"$PY" tools/pro-train/export_pro_semantic_onnx.py \
  "${ARGS[@]}"
