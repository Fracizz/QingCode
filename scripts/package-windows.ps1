# Default Windows x64 packaging: NSIS installer only.
# Portable exe: pnpm package:exe
# Usage: ./scripts/package-windows.ps1 [-Force] [-SkipFrontend] [-SkipIcons]
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipFrontend,
  [switch]$SkipIcons
)

$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'package-installer.ps1'
& $installer @PSBoundParameters
exit $LASTEXITCODE
