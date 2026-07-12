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
cd $LAB
$PY workspace/tools/pro-train/train_distill_backbone.py \
  --backbone convnext_tiny \
  --out $LAB/outputs/distill/smoke-convnext \
  --limit 256 --epochs 1 --batch 32 --workers 6
