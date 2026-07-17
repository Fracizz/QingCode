[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
  [string]$Version
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$tag = "v$Version"
$versioned = Join-Path $projectRoot "release\QingCode_$Version.exe"
$latest = Join-Path $projectRoot 'release\QingCode.exe'

if (-not (Test-Path -LiteralPath $versioned)) {
  throw "Missing $versioned. Run pnpm package:exe first."
}
if (-not (Test-Path -LiteralPath $latest)) {
  throw "Missing $latest. Run pnpm package:exe first."
}

& (Join-Path $PSScriptRoot 'publish-gitee-release.ps1') `
  -Tag $tag `
  -Name "QingCode v$Version" `
  -Body @"
## QingCode v$Version

Windows portable build (no installer).

1. Download ``QingCode_$Version.exe``
2. Run it (WebView2 required on Windows 10/11)
3. Changelog: https://gitee.com/FrancizTest_admin/qing-code/blob/master/CHANGELOG.md
"@ `
  -Files @($versioned, $latest)
