# Build independently installable QingCode Tree-sitter language components.
# The output layout is the runtime contract:
#   language-components/<id>/<platform library + component.json>
[CmdletBinding()]
param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Debug',
  [string]$Target = '',
  [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$profile = $Configuration.ToLowerInvariant()
$componentIds = @('typescript', 'python', 'java', 'rust', 'go')
$packageNames = $componentIds | ForEach-Object { "qingcode-language-$_" }

if (-not $Destination) {
  $targetRoot = if ($env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR
  } else {
    Join-Path $projectRoot 'src-tauri\target'
  }
  $profileDir = if ($Target) {
    Join-Path $targetRoot "$Target\$profile"
  } else {
    Join-Path $targetRoot $profile
  }
  $Destination = Join-Path $profileDir 'language-components'
}

$cargoArgs = @('build', '--manifest-path', $manifest)
if ($Configuration -eq 'Release') {
  $cargoArgs += '--release'
}
if ($Target) {
  $cargoArgs += @('--target', $Target)
}
foreach ($packageName in $packageNames) {
  $cargoArgs += @('-p', $packageName)
}

Write-Host "Building language components ($Configuration)..."
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) {
  throw "Language component build failed with exit code $LASTEXITCODE."
}

$cargoTargetRoot = if ($env:CARGO_TARGET_DIR) {
  $env:CARGO_TARGET_DIR
} else {
  Join-Path $projectRoot 'src-tauri\target'
}
$artifactDir = if ($Target) {
  Join-Path $cargoTargetRoot "$Target\$profile"
} else {
  Join-Path $cargoTargetRoot $profile
}

$libraryPrefix = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '' } else { 'lib' }
$libraryExtension = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  '.dll'
} elseif ($IsMacOS) {
  '.dylib'
} else {
  '.so'
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
foreach ($componentId in $componentIds) {
  $sourceName = "${libraryPrefix}qingcode_language_${componentId}${libraryExtension}"
  $source = Join-Path $artifactDir $sourceName
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Language component artifact not found: $source"
  }
  $componentDir = Join-Path $Destination $componentId
  New-Item -ItemType Directory -Force -Path $componentDir | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $componentDir $sourceName) -Force
  Copy-Item `
    -LiteralPath (Join-Path $projectRoot "src-tauri\language-components\$componentId\component.json") `
    -Destination (Join-Path $componentDir 'component.json') `
    -Force
}

Write-Host "Language components staged at $Destination" -ForegroundColor Green
