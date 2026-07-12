param(
  [string]$Audit = "output\ai-bench\ai-culling-bench-1781541318533.json",
  [string]$Candidates = "output\ai-bench\aesthetic-candidates\aesthetic-candidates-20260616-104143.csv",
  [string]$Labels = "D:\FrameCullRawAudit\raw-audit-previews\labels.json",
  [string]$Output = "output\ai-bench\supervised-ai-picks",
  [string]$Ratios = "0.38,0.45,0.5,0.6",
  [string]$Lab = "D:\FrameCullModelLab",
  [string]$Mode = "standard"
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

node tools\ai-lab\tune-ai-picks-supervised.mjs `
  --audit $Audit `
  --candidates $Candidates `
  --labels $Labels `
  --output $Output `
  --ratios $Ratios `
  --model-lab-dir $Lab `
  --mode $Mode
