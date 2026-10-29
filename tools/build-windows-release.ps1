[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$SkipValidation,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  Write-Host "`n> $Command $($Arguments -join ' ')" -ForegroundColor Cyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha256.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes).Replace("-", "")).ToLowerInvariant()
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "The Windows desktop release must be built on Windows."
}

foreach ($command in @("node", "npm", "cargo", "rustc")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required build tool '$command' is not available on PATH."
  }
}

Push-Location $repoRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "src-tauri\tauri.conf.json"))) {
    throw "The Tauri desktop shell is missing: src-tauri\tauri.conf.json"
  }
  $tauriConfig = Get-Content -LiteralPath (Join-Path $repoRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
  $appVersion = [string]$tauriConfig.version
  if ([string]::IsNullOrWhiteSpace($appVersion)) {
    throw "The Tauri app version is missing from src-tauri\tauri.conf.json."
  }

  if (-not $SkipInstall) {
    Invoke-Checked -Command "npm" -Arguments @("ci")
  }

  if (-not $SkipValidation) {
    Invoke-Checked -Command "npm" -Arguments @("test")
    Invoke-Checked -Command "npm" -Arguments @("run", "validate:schema")
    Invoke-Checked -Command "cargo" -Arguments @("fmt", "--all", "--", "--check")
    Invoke-Checked -Command "cargo" -Arguments @("clippy", "--workspace", "--all-targets", "--", "-D", "warnings")
    Invoke-Checked -Command "cargo" -Arguments @("test", "--workspace", "--all-targets")
  }

  if (-not $SkipBuild) {
    # `desktop:build` is the single source of truth for the Tauri bundle. Its
    # beforeBuildCommand also produces the current web assets.
    Invoke-Checked -Command "npm" -Arguments @("run", "desktop:build")
    Invoke-Checked -Command "npm" -Arguments @("run", "build:extension")
    Invoke-Checked -Command "powershell" -Arguments @("-ExecutionPolicy", "Bypass", "-File", ".\tools\build-windows-apo.ps1")
  }

  $artifactCandidates = @()
  $targetRoot = Join-Path $repoRoot "target\release"
  $tauriTargetRoot = Join-Path $repoRoot "src-tauri\target\release"
  foreach ($root in @($targetRoot, $tauriTargetRoot)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $artifactCandidates += Get-ChildItem -LiteralPath $root -File -Filter "*.exe" -ErrorAction SilentlyContinue
    $bundleRoot = Join-Path $root "bundle"
    if (Test-Path -LiteralPath $bundleRoot) {
      $artifactCandidates += Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Extension -in @(".exe", ".msi", ".msix") -and $_.Name.Contains($appVersion)
        }
    }
  }

  $artifacts = $artifactCandidates | Sort-Object FullName -Unique | Group-Object Name | ForEach-Object { $_.Group[0] }
  if (-not $artifacts) {
    throw "Tauri completed but no Windows executable or installer was found under target\release."
  }

  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $releaseRoot = Join-Path $repoRoot "release"
  $outputRoot = Join-Path $releaseRoot "windows-$stamp"
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

  $checksumLines = @()
  foreach ($artifact in $artifacts) {
    $destination = Join-Path $outputRoot $artifact.Name
    Copy-Item -LiteralPath $artifact.FullName -Destination $destination
    $hash = Get-Sha256Hex -Path $destination
    $checksumLines += "$hash  $($artifact.Name)"
  }

  $extensionManifest = Get-Content -LiteralPath (Join-Path $repoRoot "extensions\chrome\manifest.json") -Raw | ConvertFrom-Json
  $extensionSource = Join-Path $repoRoot "target\extension\uzjam-tab-audio-$($extensionManifest.version)"
  $extensionZipSource = "$extensionSource.zip"
  $extensionIncluded = $false
  if ((Test-Path -LiteralPath $extensionSource) -and (Test-Path -LiteralPath $extensionZipSource)) {
    $extensionDestination = Join-Path $outputRoot "uzjam-tab-audio-extension"
    Copy-Item -LiteralPath $extensionSource -Destination $extensionDestination -Recurse -Force
    $extensionZipDestination = Join-Path $outputRoot "uzjam-tab-audio-extension.zip"
    Copy-Item -LiteralPath $extensionZipSource -Destination $extensionZipDestination
    $checksumLines += "$(Get-Sha256Hex -Path $extensionZipDestination)  uzjam-tab-audio-extension.zip"
    $extensionIncluded = $true
  }

  $apoPackageSource = Join-Path $repoRoot "target\apo\x64\release\package"
  $apoPackageIncluded = $false
  if (Test-Path -LiteralPath $apoPackageSource) {
    $apoPackageDestination = Join-Path $outputRoot "apo-development-package"
    Copy-Item -LiteralPath $apoPackageSource -Destination $apoPackageDestination -Recurse -Force
    Get-ChildItem -LiteralPath $apoPackageDestination -File | ForEach-Object {
      $relativeName = "apo-development-package/$($_.Name)"
      $checksumLines += "$(Get-Sha256Hex -Path $_.FullName)  $relativeName"
    }
    $apoPackageIncluded = $true
  }
  [System.IO.File]::WriteAllLines((Join-Path $outputRoot "SHA256SUMS.txt"), $checksumLines)

  $gitRevision = "unavailable"
  $gitDirty = $null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $gitRevision = (& git rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { $gitRevision = "unavailable" }
    $gitDirty = [bool](& git status --porcelain 2>$null)
  }
  $buildInfo = [ordered]@{
    builtAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    gitRevision = $gitRevision
    workingTreeDirty = $gitDirty
    node = (& node --version)
    npm = (& npm --version)
    rustc = (& rustc --version)
    validationSkipped = [bool]$SkipValidation
    appVersion = $appVersion
    artifacts = @($artifacts | ForEach-Object { $_.Name })
    apoDevelopmentPackageIncluded = $apoPackageIncluded
    apoDevelopmentPackageInstallable = $false
    chromeExtensionIncluded = $extensionIncluded
  }
  $buildInfo | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputRoot "build-info.json") -Encoding utf8

  Write-Host "`nWindows release ready: $outputRoot" -ForegroundColor Green
  Get-ChildItem -LiteralPath $outputRoot -File | Select-Object Name, Length
}
finally {
  Pop-Location
}
