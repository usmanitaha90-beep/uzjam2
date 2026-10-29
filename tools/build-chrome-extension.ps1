[CmdletBinding()]
param(
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot "extensions\chrome"
$manifestPath = Join-Path $sourceRoot "manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Chrome extension manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$requiredFiles = @(
  "manifest.json",
  "background.js",
  "offscreen.html",
  "offscreen.js",
  "pcm-worklet.js",
  "popup.html",
  "popup.css",
  "popup.js"
)
foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $file))) {
    throw "Chrome extension file is missing: $file"
  }
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repoRoot "target\extension"
}
$resolvedRepo = [System.IO.Path]::GetFullPath($repoRoot)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not $resolvedOutput.StartsWith($resolvedRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Extension output must stay inside the UZjam repository."
}

New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
$folderName = "uzjam-tab-audio-$($manifest.version)"
$stagedFolder = Join-Path $resolvedOutput $folderName
$zipPath = Join-Path $resolvedOutput "$folderName.zip"
if (Test-Path -LiteralPath $stagedFolder) {
  Remove-Item -LiteralPath $stagedFolder -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $stagedFolder | Out-Null
foreach ($file in $requiredFiles) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $stagedFolder $file)
}
Compress-Archive -Path (Join-Path $stagedFolder "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Chrome extension ready:" -ForegroundColor Green
Write-Host "  Unpacked: $stagedFolder"
Write-Host "  Zip:      $zipPath"
