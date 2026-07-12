#!/bin/bash
set -e
LAB=/data/FrameCullModelLab
mkdir -p "$LAB/tmp" "$LAB/outputs/distill"
rm -f "$LAB/tmp/full_distill.log"
nohup bash "$LAB/tmp/run_full_distill.sh" > "$LAB/tmp/full_distill.log" 2>&1 < /dev/null &
echo $! > "$LAB/tmp/full_distill.pid"
echo "started $(cat "$LAB/tmp/full_distill.pid")"
