param(
  [string]$Audit = "output\ai-bench\ai-culling-bench-scene-aware-replay.json",
  [string]$Labels = "D:\FrameCullRawAudit\raw-audit-previews\labels.json",
  [string]$Previews = "D:\FrameCullRawAudit\raw-audit-previews",
  [string]$Candidates = "output\ai-bench\aesthetic-candidates\aesthetic-candidates-20260616-104143.csv",
  [string]$Lab = "D:\FrameCullModelLab",
  [string]$Output = "output\ai-bench\personal-ranker",
  [string]$Models = "core-linear,core-mlp,clip-linear,fused-clip-linear,dinov2-linear,fused-dinov2-linear",
  [string]$Ratios = "0.38,0.45,0.5,0.6",
  [ValidateSet("auto", "cuda", "cpu")]
  [string]$Device = "auto",
  [int]$Epochs = 220
)

$ErrorActionPreference = "Stop"

$env:FRAMECULL_MODEL_LAB_DIR = $Lab
$env:HF_HOME = Join-Path $Lab "cache\huggingface"
$env:HUGGINGFACE_HUB_CACHE = Join-Path $Lab "cache\huggingface\hub"
$env:TRANSFORMERS_CACHE = Join-Path $Lab "cache\huggingface\transformers"
$env:TORCH_HOME = Join-Path $Lab "cache\torch"
$env:XDG_CACHE_HOME = Join-Path $Lab "cache\xdg"
$env:PIP_CACHE_DIR = Join-Path $Lab "cache\pip"
$env:TEMP = Join-Path $Lab "cache\tmp"
$env:TMP = Join-Path $Lab "cache\tmp"

New-Item -ItemType Directory -Force -Path $env:HF_HOME, $env:HUGGINGFACE_HUB_CACHE, $env:TRANSFORMERS_CACHE, $env:TORCH_HOME, $env:XDG_CACHE_HOME, $env:PIP_CACHE_DIR, $env:TEMP | Out-Null

$python = Join-Path $Lab ".venv\Scripts\python.exe"
if (!(Test-Path $python)) {
  throw "Missing D-drive Python environment: $python"
}

& $python tools\ai-lab\train-personal-ranker.py `
  --audit $Audit `
  --labels $Labels `
  --previews $Previews `
  --candidates $Candidates `
  --lab $Lab `
  --output $Output `
  --models $Models `
  --ratios $Ratios `
  --device $Device `
  --epochs $Epochs
