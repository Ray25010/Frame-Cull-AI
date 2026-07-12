#!/usr/bin/env bash
# Train FrameCull Pro Semantic Student V2 on the 5090 lab server.
# Usage:
#   run_semantic_student_server.sh grounded
#   run_semantic_student_server.sh flat

set -euo pipefail

MODE="${1:-grounded}"
LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
BACKBONE="${FRAMECULL_STUDENT_BACKBONE:-convnext_tiny}"
EPOCHS="${FRAMECULL_STUDENT_EPOCHS:-30}"
BATCH="${FRAMECULL_STUDENT_BATCH:-64}"
WORKERS="${FRAMECULL_STUDENT_WORKERS:-8}"
LIMIT="${FRAMECULL_STUDENT_LIMIT:-}"
MIN_BATCH="${FRAMECULL_STUDENT_MIN_BATCH:-8}"
CUSTOM_TEACHER="${FRAMECULL_SEMANTIC_TEACHER:-}"
CUSTOM_OUT="${FRAMECULL_STUDENT_OUT:-}"
EXPECTED_TEACHER_SHA="${FRAMECULL_STUDENT_EXPECTED_TEACHER_SHA-}"
EXPECTED_TEACHER_SHA_SET="${FRAMECULL_STUDENT_EXPECTED_TEACHER_SHA+set}"

case "$MODE" in
  grounded)
    TEACHER="${CUSTOM_TEACHER:-$LAB/features/semantic-teacher/semantic-teacher-v1.jsonl}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/semantic-student/grounded-convnext}"
    VALIDATE_ARGS=()
    TRAIN_EXTRA=()
    ;;
  flat)
    TEACHER="${CUSTOM_TEACHER:-$LAB/features/semantic-teacher/semantic-teacher-v1-flat.jsonl}"
    OUT="${CUSTOM_OUT:-$LAB/outputs/semantic-student/flat-convnext}"
    VALIDATE_ARGS=(--allow-flat-scalar)
    TRAIN_EXTRA=(--allow-flat-scalar-teacher)
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

if [[ ! -s "$TEACHER" ]]; then
  echo "Missing semantic teacher file: $TEACHER" >&2
  exit 1
fi

"$PY" tools/pro-train/semantic_teacher_schema.py "$TEACHER" "${VALIDATE_ARGS[@]}"

ARGS=(
  tools/pro-train/train_semantic_student.py
  --semantic-teacher "$TEACHER"
  --quality-teacher-dir "$LAB/features/teacher"
  --camera-previews "$LAB/incoming/camera-previews-384"
  --audit-previews "$LAB/incoming/raw-audit-previews"
  --out "$OUT"
  --backbone "$BACKBONE"
  --epochs "$EPOCHS"
  --workers "$WORKERS"
)

if [[ -n "$LIMIT" ]]; then
  ARGS+=(--limit "$LIMIT")
fi
if [[ -n "${EXPECTED_TEACHER_SHA_SET:-}" ]]; then
  ARGS+=(--expected-teacher-sha256 "$EXPECTED_TEACHER_SHA")
fi
ARGS+=("${TRAIN_EXTRA[@]}")

run_once() {
  local batch="$1"
  local attempt_log="$OUT/train-attempt-batch${batch}.log"
  local cmd=("${ARGS[@]}" --batch "$batch")
  echo "[semantic-student-server] mode=$MODE teacher=$TEACHER out=$OUT backbone=$BACKBONE epochs=$EPOCHS batch=$batch workers=$WORKERS"
  set +e
  "$PY" "${cmd[@]}" 2>&1 | tee "$attempt_log"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

current_batch="$BATCH"
while true; do
  if run_once "$current_batch"; then
    exit 0
  fi
  attempt_log="$OUT/train-attempt-batch${current_batch}.log"
  if [[ "$current_batch" -le "$MIN_BATCH" ]]; then
    echo "[semantic-student-server][error] training failed at minimum batch=$current_batch" >&2
    exit 1
  fi
  if ! grep -qi "CUDA out of memory" "$attempt_log"; then
    echo "[semantic-student-server][error] training failed for non-OOM reason; see $attempt_log" >&2
    exit 1
  fi
  next_batch=$(( current_batch / 2 ))
  if [[ "$next_batch" -lt "$MIN_BATCH" ]]; then
    next_batch="$MIN_BATCH"
  fi
  if [[ "$next_batch" -ge "$current_batch" ]]; then
    echo "[semantic-student-server][error] unable to reduce batch below $current_batch after OOM" >&2
    exit 1
  fi
  echo "[semantic-student-server][warn] CUDA OOM at batch=$current_batch; retrying with batch=$next_batch" >&2
  current_batch="$next_batch"
done
