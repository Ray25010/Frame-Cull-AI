#!/bin/bash
set -e
LAB=/data/FrameCullModelLab
mkdir -p "$LAB/tmp" "$LAB/outputs/persona"
rm -f "$LAB/tmp/full_persona.log"
nohup bash "$LAB/tmp/run_full_persona.sh" > "$LAB/tmp/full_persona.log" 2>&1 < /dev/null &
echo $! > "$LAB/tmp/full_persona.pid"
echo "started $(cat "$LAB/tmp/full_persona.pid")"
