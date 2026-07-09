#!/bin/bash
set -e
LAB=/data/FrameCullModelLab
export HF_HOME=$LAB/cache/huggingface
export HUGGINGFACE_HUB_CACHE=$LAB/cache/huggingface/hub
export TORCH_HOME=$LAB/cache/torch
export TMPDIR=$LAB/tmp
export XDG_CACHE_HOME=$LAB/cache
export HTTP_PROXY=socks5h://127.0.0.1:10808
export HTTPS_PROXY=socks5h://127.0.0.1:10808
export ALL_PROXY=socks5h://127.0.0.1:10808
export PYTHONPATH=$LAB/workspace/tools/pro-train
PY=/home/hph/miniconda3/envs/train5090/bin/python
TRAIN=$LAB/workspace/tools/pro-train/train_persona_head.py
cd $LAB

echo "=====[persona A] convnext_tiny ====="
$PY $TRAIN \
  --student $LAB/outputs/distill/convnext_tiny/student-best.pt \
  --out $LAB/outputs/persona/convnext_tiny \
  --epochs 80 --batch 256 --image-batch 64 --workers 8

echo "=====[persona B] deit_tiny ====="
$PY $TRAIN \
  --student $LAB/outputs/distill/deit_tiny/student-best.pt \
  --out $LAB/outputs/persona/deit_tiny \
  --epochs 80 --batch 256 --image-batch 64 --workers 8

echo "==FULL_PERSONA_ALL_DONE=="
