#!/usr/bin/env bash
# Server runner for FrameCull Pro Semantic Teacher annotation.
# No secrets are stored here. Launch through SSH and redirect stdout/stderr to a log.

set -euo pipefail

MODE="${1:-grounded}"
LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
INPUT="${FRAMECULL_TEACHER_INPUT:-$LAB/outputs/semantic-teacher-lab/phase0/all-images.json}"
MODEL="${FRAMECULL_TEACHER_MODEL:-Qwen/Qwen2.5-VL-7B-Instruct}"
COMMON_MAX_NEW_TOKENS="${FRAMECULL_TEACHER_MAX_NEW_TOKENS:-}"
LIMIT="${FRAMECULL_TEACHER_LIMIT:-}"
ALLOW_PREVIEW_FALLBACK="${FRAMECULL_ALLOW_PREVIEW_FALLBACK:-0}"
PY="${FRAMECULL_PYTHON:-/home/hph/miniconda3/envs/train5090/bin/python}"
LICENSE_DIR="${FRAMECULL_LICENSE_DIR:-$LAB/outputs/semantic-teacher-lab}"
LICENSE_JSON="$LICENSE_DIR/teacher-license-clearance.json"

case "$MODE" in
  grounded)
    MAX_NEW_TOKENS="${FRAMECULL_TEACHER_MAX_NEW_TOKENS_GROUNDED:-${COMMON_MAX_NEW_TOKENS:-1000}}"
    OUT="$LAB/features/semantic-teacher/semantic-teacher-v1.jsonl"
    SUMMARY="$LAB/features/semantic-teacher/semantic-teacher-v1.summary.json"
    EXTRA_ARGS=()
    FLAT_SCALAR=0
    ;;
  flat)
    # Flat-scalar ablation emits only compact scalar JSON plus short reasons.
    # Keep its default generation budget tighter than grounded mode so the
    # ablation can finish in reasonable time without changing schema semantics.
    MAX_NEW_TOKENS="${FRAMECULL_TEACHER_MAX_NEW_TOKENS_FLAT:-${COMMON_MAX_NEW_TOKENS:-256}}"
    OUT="$LAB/features/semantic-teacher/semantic-teacher-v1-flat.jsonl"
    SUMMARY="$LAB/features/semantic-teacher/semantic-teacher-v1-flat.summary.json"
    EXTRA_ARGS=(--flat-scalar)
    FLAT_SCALAR=1
    ;;
  *)
    echo "Usage: $0 grounded|flat" >&2
    exit 2
    ;;
esac

export HF_HOME="$LAB/cache/huggingface"
export HUGGINGFACE_HUB_CACHE="$LAB/cache/huggingface"
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export TRANSFORMERS_OFFLINE="${TRANSFORMERS_OFFLINE:-1}"
export TORCH_HOME="$LAB/cache/torch"
export XDG_CACHE_HOME="$LAB/cache/xdg"
export TMPDIR="$LAB/tmp"

mkdir -p "$LAB/features/semantic-teacher" "$LAB/outputs/semantic-teacher-lab/raw-vlm" "$LAB/tmp"
cd "$WORKSPACE"

if [[ "$MODE" == "grounded" && -z "$LIMIT" ]]; then
  FRAMECULL_LICENSE_JSON="$LICENSE_JSON" FRAMECULL_TEACHER_MODEL="$MODEL" "$PY" - <<'PY'
import json
import os
import sys
from pathlib import Path

license_json = Path(os.environ["FRAMECULL_LICENSE_JSON"])
model_id = os.environ["FRAMECULL_TEACHER_MODEL"].strip()
normalized = model_id.split("/")[-1].strip().lower()

if not license_json.exists():
    print(
        f"[semantic-teacher-server][fatal] missing teacher license gate: {license_json}. "
        "Run tools/pro-train/teacher_license_clearance.py before full grounded annotation.",
        file=sys.stderr,
    )
    sys.exit(2)

try:
    payload = json.loads(license_json.read_text(encoding="utf-8"))
except Exception as error:
    print(f"[semantic-teacher-server][fatal] invalid license gate json: {error}", file=sys.stderr)
    sys.exit(2)

if str(payload.get("gateStatus") or "").upper() != "PASS":
    print("[semantic-teacher-server][fatal] teacher license gate is not PASS.", file=sys.stderr)
    sys.exit(2)

cleared = {str(item).strip().lower() for item in payload.get("clearedTeacherIds") or []}
if normalized not in cleared:
    print(
        f"[semantic-teacher-server][fatal] model '{model_id}' is not cleared for full annotation. "
        f"Cleared teachers: {sorted(cleared)}",
        file=sys.stderr,
    )
    sys.exit(2)
PY
fi

LINEAGE_STATUS="$("$PY" tools/pro-train/inspect_teacher_lineage.py --input "$INPUT" --output "$OUT" --summary "$SUMMARY")"
echo "[semantic-teacher-server] lineage=$LINEAGE_STATUS"

RESUME_FLAG=()
if ! FRAMECULL_LINEAGE_STATUS="$LINEAGE_STATUS" "$PY" - <<'PY'
import json
import os
import sys
payload = json.loads(os.environ["FRAMECULL_LINEAGE_STATUS"])
sys.exit(0 if payload.get("resumeSafe") else 1)
PY
then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  for stale in "$OUT" "$SUMMARY" "${OUT%.jsonl}.failures.csv"; do
    if [[ -f "$stale" ]]; then
      mv "$stale" "${stale}.stale-$STAMP"
      echo "[semantic-teacher-server] archived stale artifact $stale -> ${stale}.stale-$STAMP"
    fi
  done
else
  RESUME_FLAG+=(--resume)
fi

ARGS=(
  tools/pro-train/run_semantic_teacher.py
  --input "$INPUT"
  --out "$OUT"
  --backend qwen2_5_vl
  --model "$MODEL"
  --cache "$LAB/cache/huggingface"
  --raw-dir "$LAB/outputs/semantic-teacher-lab/raw-vlm"
  --max-new-tokens "$MAX_NEW_TOKENS"
  --summary "$SUMMARY"
)

if [[ -n "$LIMIT" ]]; then
  ARGS+=(--limit "$LIMIT")
fi
if [[ "$ALLOW_PREVIEW_FALLBACK" == "1" ]]; then
  ARGS+=(--allow-preview-fallback)
fi
ARGS+=("${EXTRA_ARGS[@]}")
ARGS+=("${RESUME_FLAG[@]}")

echo "[semantic-teacher-server] mode=$MODE input=$INPUT out=$OUT max_new_tokens=$MAX_NEW_TOKENS limit=${LIMIT:-none}"
status=0
"$PY" "${ARGS[@]}" || status=$?
"$PY" tools/pro-train/sync_semantic_teacher_phase_outputs.py --lab "$LAB" || true
exit "$status"
