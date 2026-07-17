[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
  [string]$Version,
  [switch]$SkipChecks,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tag = "v$Version"

function Get-JsonVersion([string]$Path) {
  $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  return [string]$json.version
}

function Get-CargoVersion([string]$Path) {
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  $m = [regex]::Match($raw, '(?m)^version\s*=\s*"([^"]+)"')
  if (-not $m.Success) { throw "version not found in $Path" }
  return $m.Groups[1].Value
}

Push-Location $projectRoot
try {
  $pkg = Get-JsonVersion (Join-Path $projectRoot 'package.json')
  $cargo = Get-CargoVersion (Join-Path $projectRoot 'src-tauri\Cargo.toml')
  $tauri = Get-JsonVersion (Join-Path $projectRoot 'src-tauri\tauri.conf.json')

  if ($pkg -ne $Version -or $cargo -ne $Version -or $tauri -ne $Version) {
    throw @"
Version mismatch. Expected $Version in all manifests:
  package.json          = $pkg
  src-tauri/Cargo.toml  = $cargo
  src-tauri/tauri.conf  = $tauri
Run: pnpm bump:version $Version
"@
  }

  $status = git status --porcelain
  if ($status) {
    throw "Working tree is not clean. Commit or stash changes before tagging."
  }

  if (-not $SkipChecks) {
    Write-Host "Running pnpm check..." -ForegroundColor Cyan
    pnpm check
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm check failed with exit code $LASTEXITCODE."
    }
  }

  $existing = git rev-parse -q --verify "refs/tags/$tag" 2>$null
  if ($LASTEXITCODE -eq 0 -and $existing) {
    if (-not $Force) {
      throw "Tag $tag already exists. Use -Force to move it (not recommended)."
    }
    git tag -f $tag
  } else {
    git tag -a $tag -m "Release $tag"
  }

  Write-Host ""
  Write-Host "Created tag $tag" -ForegroundColor Green
  Write-Host "Push to GitHub to trigger the release workflow:" -ForegroundColor DarkGray
  Write-Host "  git push github $tag"
  Write-Host "  git push github master"
} finally {
  Pop-Location
}
