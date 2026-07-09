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
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
PY=/home/hph/miniconda3/envs/train5090/bin/python
TRAIN=$LAB/workspace/tools/pro-train/train_distill_backbone.py
cd $LAB

echo "=====[A] convnext_tiny full ====="
$PY $TRAIN \
  --backbone convnext_tiny \
  --out $LAB/outputs/distill/convnext_tiny \
  --epochs 30 --batch 64 --lr 2e-4 --workers 8

echo "=====[B] deit_tiny full ====="
$PY $TRAIN \
  --backbone deit_tiny_patch16_224 \
  --out $LAB/outputs/distill/deit_tiny \
  --epochs 30 --batch 64 --lr 2e-4 --workers 8

echo "==FULL_DISTILL_ALL_DONE=="
