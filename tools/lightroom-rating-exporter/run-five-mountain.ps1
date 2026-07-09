$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

Add-Type -AssemblyName System.Windows.Forms

function Select-Folder {
  param(
    [string]$Title,
    [string]$InitialPath
  )

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $Title
  $dialog.ShowNewFolderButton = $true
  if ($InitialPath) {
    $dialog.SelectedPath = $InitialPath
  }

  $result = $dialog.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }

  return $dialog.SelectedPath
}

$defaultPhotoDir = 'E:\BaiduNetdiskDownload\五台山全部'
$photoDir = if (Test-Path -LiteralPath $defaultPhotoDir) {
  $defaultPhotoDir
} else {
  Select-Folder -Title '选择“五台山全部”照片文件夹' -InitialPath ([Environment]::GetFolderPath('Desktop'))
}

if (-not $photoDir) {
  Write-Host '未选择照片文件夹，已取消。'
  exit 1
}

$outputDir = Select-Folder -Title '选择回传 zip 输出文件夹' -InitialPath ([Environment]::GetFolderPath('Desktop'))
if (-not $outputDir) {
  Write-Host '未选择输出文件夹，已取消。'
  exit 1
}

$py = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
  $py = 'py'
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $py = 'python'
}

if (-not $py) {
  throw '未找到 Python。请先安装 Python 3 或 Python Launcher。'
}

Write-Host "照片文件夹: $photoDir"
Write-Host "输出文件夹: $outputDir"

if ($py -eq 'py') {
  & py -3 lightroom_rating_exporter.py --output $outputDir --photo-dir $photoDir
} else {
  & python lightroom_rating_exporter.py --output $outputDir --photo-dir $photoDir
}

exit $LASTEXITCODE
