param(
  [string]$Stage = "radius-3-context",
  [string]$Models = "nima-baseline,clipiqa-pyiqa",
  [string]$Ratios = "0.38,0.5,0.6",
  [int]$Limit = 0,
  [string]$Device = "cpu",
  [int]$CandidateMaxEdge = 1024,
  [string]$Lab = "D:\FrameCullModelLab"
)

$ErrorActionPreference = "Stop"

$env:FRAMECULL_MODEL_LAB_DIR = $Lab
$env:HF_HOME = "$Lab\cache\huggingface"
$env:HUGGINGFACE_HUB_CACHE = "$Lab\cache\huggingface\hub"
$env:TRANSFORMERS_CACHE = "$Lab\cache\huggingface\transformers"
$env:TORCH_HOME = "$Lab\cache\torch"
$env:XDG_CACHE_HOME = "$Lab\cache\xdg"
$env:PIP_CACHE_DIR = "$Lab\cache\pip"
$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True"

$python = "$Lab\.venv\Scripts\python.exe"
if (!(Test-Path $python)) {
  throw "Missing D: model lab Python: $python"
}

$args = @(
  "tools\ai-lab\bench-aesthetic-candidates.py",
  "--stage", $Stage,
  "--models", $Models,
  "--ratios", $Ratios,
  "--device", $Device,
  "--candidate-max-edge", "$CandidateMaxEdge"
)
if ($Limit -gt 0) {
  $args += @("--limit", "$Limit")
}

& $python @args
