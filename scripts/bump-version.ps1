[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
  [string]$Version
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Read-TextFile([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
}

function Write-TextFile([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Set-JsonVersion([string]$Path, [string]$NewVersion) {
  $raw = Read-TextFile $Path
  $pattern = '"version"\s*:\s*"([^"]+)"'
  $m = [regex]::Match($raw, $pattern)
  if (-not $m.Success) {
    throw "version field not found in $Path"
  }
  if ($m.Groups[1].Value -eq $NewVersion) {
    Write-Host "  $([IO.Path]::GetFileName($Path)): already $NewVersion"
    return
  }
  $updated = [regex]::Replace($raw, $pattern, "`"version`": `"$NewVersion`"", 1)
  Write-TextFile $Path $updated
  Write-Host "  $([IO.Path]::GetFileName($Path)): $($m.Groups[1].Value) -> $NewVersion"
}

function Set-CargoVersion([string]$Path, [string]$NewVersion, [string]$Label = 'Cargo.toml') {
  $raw = Read-TextFile $Path
  $pattern = '(?m)^version\s*=\s*"([^"]+)"'
  $m = [regex]::Match($raw, $pattern)
  if (-not $m.Success) {
    throw "version field not found in $Path"
  }
  if ($m.Groups[1].Value -eq $NewVersion) {
    Write-Host "  ${Label}: already $NewVersion"
    return
  }
  $updated = [regex]::Replace($raw, $pattern, "version = `"$NewVersion`"", 1)
  Write-TextFile $Path $updated
  Write-Host "  ${Label}: $($m.Groups[1].Value) -> $NewVersion"
}

function Set-CargoLockPackageVersion([string]$Path, [string]$PackageName, [string]$NewVersion) {
  # Cargo.lock 里 [[package]] 按 name 定位，只改该条目自己的 version 行。
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $raw = Read-TextFile $Path
  $pattern = '(?m)(\[\[package\]\]\r?\nname = "' + [regex]::Escape($PackageName) + '"\r?\nversion = ")([^"]+)(")'
  $m = [regex]::Match($raw, $pattern)
  if (-not $m.Success) {
    throw "package $PackageName not found in $Path"
  }
  if ($m.Groups[2].Value -eq $NewVersion) {
    Write-Host "  Cargo.lock ($PackageName): already $NewVersion"
    return
  }
  $updated = [regex]::Replace(
    $raw,
    $pattern,
    ('${1}' + $NewVersion + '${3}'),
    1
  )
  Write-TextFile $Path $updated
  Write-Host "  Cargo.lock ($PackageName): $($m.Groups[2].Value) -> $NewVersion"
}

function Set-ReadmeVersion([string]$Path, [string]$NewVersion) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  # First **semver** in the README is the version badge (ASCII-only pattern).
  $raw = Read-TextFile $Path
  $pattern = '(\*\*)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\*\*)'
  $m = [regex]::Match($raw, $pattern)
  if (-not $m.Success) {
    Write-Host "  $([IO.Path]::GetFileName($Path)): no version badge line"
    return
  }
  if ($m.Groups[2].Value -eq $NewVersion) {
    Write-Host "  $([IO.Path]::GetFileName($Path)): already $NewVersion"
    return
  }
  $updated = [regex]::Replace($raw, $pattern, ('${1}' + $NewVersion + '${3}'), 1)
  Write-TextFile $Path $updated
  Write-Host "  $([IO.Path]::GetFileName($Path)): $($m.Groups[2].Value) -> $NewVersion"
}

$packageJson = Join-Path $projectRoot 'package.json'
$cargoToml = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$agentCargoToml = Join-Path $projectRoot 'src-tauri\qingcode-agent\Cargo.toml'
$cargoLock = Join-Path $projectRoot 'src-tauri\Cargo.lock'
$tauriConf = Join-Path $projectRoot 'src-tauri\tauri.conf.json'

Write-Host "Bumping version to $Version" -ForegroundColor Cyan
Set-JsonVersion $packageJson $Version
Set-CargoVersion $cargoToml $Version 'Cargo.toml'
Set-JsonVersion $tauriConf $Version
# 远端 agent 版本（AGENT_VERSION）取自该 crate 的版本，漏 bump 会让已部到远端的
# agent 版本漂移、每次连接都重部署。
Set-CargoVersion $agentCargoToml $Version 'qingcode-agent/Cargo.toml'
Set-CargoLockPackageVersion $cargoLock 'qingcode' $Version
Set-CargoLockPackageVersion $cargoLock 'qingcode-agent' $Version
Set-ReadmeVersion (Join-Path $projectRoot 'README.md') $Version
Set-ReadmeVersion (Join-Path $projectRoot 'README.en.md') $Version

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Next: update CHANGELOG.md, commit, then pnpm release:tag $Version" -ForegroundColor DarkGray
