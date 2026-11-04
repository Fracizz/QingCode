[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('frontend', 'icons', 'server', 'embed')][string]$Stage,
  [switch]$SkipServer
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  . (Join-Path $PSScriptRoot 'package-common.ps1')
  switch ($Stage) {
    'frontend' {
      if (Test-FrontendStale -ProjectRoot $projectRoot) {
        pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
      } else { Write-Host 'Frontend up to date.' }
    }
    'icons' {
      $source = Get-Item -LiteralPath 'public/app-icon-file.svg'
      $icon = Get-Item -LiteralPath 'src-tauri/icons/icon.ico' -ErrorAction SilentlyContinue
      if (-not $icon -or $source.LastWriteTimeUtc -gt $icon.LastWriteTimeUtc) {
        pnpm icon:sync
        if ($LASTEXITCODE -ne 0) { throw 'Icon sync failed.' }
      } else { Write-Host 'Icons up to date.' }
    }
    'server' {
      Invoke-ServerBinaryBuild -ProjectRoot $projectRoot -SkipServer:$SkipServer
      Publish-ServerOfflinePack -ProjectRoot $projectRoot
    }
    'embed' {
      $exePath = Join-Path (Resolve-CargoReleaseDir -ProjectRoot $projectRoot) 'qingcode.exe'
      if (Test-Path -LiteralPath $exePath) {
        $builtAt = (Get-Item -LiteralPath $exePath).LastWriteTimeUtc
        $changed = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'dist'), (Join-Path $projectRoot 'src-tauri/icons') -File -Recurse |
          Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1
        if ($changed) { Invoke-ForceQingcodeEmbedRebuild -ProjectRoot $projectRoot }
        else { Write-Host 'Embedded assets up to date.' }
      }
    }
  }
} finally { Pop-Location }
