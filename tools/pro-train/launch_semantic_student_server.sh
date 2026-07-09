#!/usr/bin/env bash
# Background launcher for semantic student training.

set -euo pipefail

MODE="${1:-grounded}"
LAB="${FRAMECULL_LAB:-/data/FrameCullModelLab}"
WORKSPACE="${FRAMECULL_WORKSPACE:-$LAB/workspace}"
mkdir -p "$LAB/logs"

LOG="$LAB/logs/semantic-student-${MODE}.log"
PID="$LAB/logs/semantic-student-${MODE}.pid"

setsid "$WORKSPACE/tools/pro-train/run_semantic_student_server.sh" "$MODE" > "$LOG" 2>&1 < /dev/null &
echo $! > "$PID"
echo "started mode=$MODE pid=$(cat "$PID") log=$LOG"
