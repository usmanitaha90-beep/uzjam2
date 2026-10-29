param(
    [ValidateSet("x64")]
    [string]$Architecture = "x64",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$vsRoot = "C:\Program Files\Microsoft Visual Studio\18\Community"
$msvcRoot = Get-ChildItem -LiteralPath (Join-Path $vsRoot "VC\Tools\MSVC") -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
$sdkRoot = "C:\Program Files (x86)\Windows Kits\10"
$sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot "Include") -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "um\audioengineextensionapo.h") } |
    Sort-Object Name -Descending |
    Select-Object -First 1

if ($null -eq $msvcRoot -or $null -eq $sdkVersion) {
    throw "Visual Studio C++ and the Windows 11 SDK audio headers are required."
}

$cl = Join-Path $msvcRoot.FullName "bin\Hostx64\x64\cl.exe"
if (-not (Test-Path -LiteralPath $cl)) {
    throw "MSVC x64 compiler was not found at $cl"
}

$outputRoot = Join-Path $repoRoot "target\apo\x64\release"
$objectRoot = Join-Path $outputRoot "obj"
New-Item -ItemType Directory -Path $objectRoot -Force | Out-Null

Push-Location $repoRoot
try {
    cargo test -p uzjam-apo-ffi
    if ($LASTEXITCODE -ne 0) { throw "Rust APO bridge tests failed." }
    cargo build -p uzjam-apo-ffi --release
    if ($LASTEXITCODE -ne 0) { throw "Rust APO bridge release build failed." }

    $includeArgs = @(
        "/I$($msvcRoot.FullName)\include",
        "/I$sdkRoot\Include\$($sdkVersion.Name)\ucrt",
        "/I$sdkRoot\Include\$($sdkVersion.Name)\shared",
        "/I$sdkRoot\Include\$($sdkVersion.Name)\um",
        "/I$sdkRoot\Include\$($sdkVersion.Name)\winrt",
        "/I$repoRoot\windows\apo\include"
    )
    $libPaths = @(
        "/LIBPATH:$($msvcRoot.FullName)\lib\x64",
        "/LIBPATH:$($msvcRoot.FullName)\atlmfc\lib\x64",
        "/LIBPATH:$sdkRoot\Lib\$($sdkVersion.Name)\ucrt\x64",
        "/LIBPATH:$sdkRoot\Lib\$($sdkVersion.Name)\um\x64"
    )
    $commonCompiler = @(
        "/nologo", "/std:c++20", "/O2", "/GL", "/MD", "/W4", "/WX",
        "/guard:cf", "/DWIN32_LEAN_AND_MEAN", "/DUNICODE", "/D_UNICODE",
        "/DWINVER=0x0A00", "/D_WIN32_WINNT=0x0A00"
    ) + $includeArgs

    $apoSource = Join-Path $repoRoot "windows\apo\src\uzjam_endpoint_apo.cpp"
    $apoDefinition = Join-Path $repoRoot "windows\apo\src\uzjam_endpoint_apo.def"
    $apoDll = Join-Path $outputRoot "uzjam_endpoint_apo.dll"
    $apoPdb = Join-Path $outputRoot "uzjam_endpoint_apo.pdb"
    $rustLibrary = Join-Path $repoRoot "target\release\uzjam_apo_ffi.lib"
    $apoObject = Join-Path $objectRoot "uzjam_endpoint_apo.obj"
    & $cl @commonCompiler /c $apoSource "/Fo$apoObject"
    if ($LASTEXITCODE -ne 0) { throw "UZjam endpoint APO C++ compilation failed." }

    $systemLibraries = @(
        "AudioBaseProcessingObjectV140.lib", "audiomediatypecrt.lib", "AudioEng.lib",
        "propsys.lib", "ole32.lib", "oleaut32.lib", "uuid.lib", "advapi32.lib",
        "userenv.lib", "bcrypt.lib", "ws2_32.lib", "ntdll.lib", "kernel32.lib"
    )
    & $cl /nologo /LD /GL $apoObject $rustLibrary "/Fe$apoDll" /link "/DEF:$apoDefinition" "/PDB:$apoPdb" /LTCG /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /CETCOMPAT @libPaths @systemLibraries
    if ($LASTEXITCODE -ne 0) { throw "UZjam endpoint APO DLL link failed." }

    $smokeSource = Join-Path $repoRoot "windows\apo\tests\apo_smoke.cpp"
    $smokeExe = Join-Path $outputRoot "apo_smoke.exe"
    $smokeObject = Join-Path $objectRoot "apo_smoke.obj"
    & $cl @commonCompiler /c $smokeSource "/Fo$smokeObject"
    if ($LASTEXITCODE -ne 0) { throw "APO smoke-test compilation failed." }
    & $cl /nologo /GL $smokeObject "/Fe$smokeExe" /link /LTCG /OPT:REF /DYNAMICBASE /NXCOMPAT /CETCOMPAT @libPaths "audiomediatypecrt.lib" "AudioEng.lib" "ole32.lib" "uuid.lib" "kernel32.lib"
    if ($LASTEXITCODE -ne 0) { throw "APO smoke-test link failed." }

    if (-not $SkipTests) {
        & $smokeExe $apoDll
        if ($LASTEXITCODE -ne 0) { throw "Compiled endpoint APO smoke test failed." }
    }

    $packageRoot = Join-Path $outputRoot "package"
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    Copy-Item -LiteralPath $apoDll -Destination (Join-Path $packageRoot "uzjam_endpoint_apo.dll") -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "windows\apo\package\uzjam-apo-component.inf") -Destination $packageRoot -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "windows\apo\package\uzjam-device-extension.template.inf") -Destination $packageRoot -Force

    $manifest = @{
        architecture = $Architecture
        windowsSdk = $sdkVersion.Name
        componentInf = "uzjam-apo-component.inf"
        deviceExtensionTemplate = "uzjam-device-extension.template.inf"
        installable = $false
        reason = "Catalog generation, Microsoft driver signing, and a device-specific extension INF are required."
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $packageRoot "package-status.json") -Encoding utf8

    Get-FileHash -Algorithm SHA256 -LiteralPath $apoDll, (Join-Path $packageRoot "uzjam-apo-component.inf") |
        Select-Object Path, Hash
} finally {
    Pop-Location
}
