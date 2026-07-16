[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

Push-Location $projectRoot
try {
  pnpm tauri dev
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri dev failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
