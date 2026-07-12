param(
  [string]$Tag = "",
  [switch]$IncludeJsonl,
  [switch]$IncludeNpz,
  [switch]$IncludeModels,
  [switch]$IncludeCheckpoints,
  [switch]$IncludeRawVlm,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$python = 'C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$script = Join-Path $repoRoot 'tools\pro-train\collect_semantic_teacher_paper_artifacts.py'

if (-not (Test-Path $python)) {
  throw "Bundled Python not found: $python"
}

if (-not $env:FC_SSH_PASS) {
  $secure = Read-Host '请输入 FC_SSH_PASS (服务器密码，只用于当前会话)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:FC_SSH_PASS = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$args = @($script)
if ($Tag) { $args += @('--tag', $Tag) }
if ($IncludeJsonl) { $args += '--include-jsonl' }
if ($IncludeNpz) { $args += '--include-npz' }
if ($IncludeModels) { $args += '--include-models' }
if ($IncludeCheckpoints) { $args += '--include-checkpoints' }
if ($IncludeRawVlm) { $args += '--include-raw-vlm' }
if ($NoZip) { $args += '--no-zip' }

Write-Host '[FrameCull] 开始收集 Semantic Teacher / Student 论文快照...' -ForegroundColor Cyan
& $python @args
