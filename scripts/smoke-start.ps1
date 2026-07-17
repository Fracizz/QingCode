[CmdletBinding()]
param(
  # Portable exe to launch (defaults to release/QingCode.exe).
  [string]$ExePath = '',
  # How long the process may stay running before we stop it.
  [int]$WaitSeconds = 4
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $ExePath) {
  $ExePath = Join-Path $projectRoot 'release\QingCode.exe'
}

if (-not (Test-Path $ExePath)) {
  throw "Smoke start failed: missing exe at $ExePath"
}

Write-Host "> Smoke start: $ExePath" -ForegroundColor Cyan
$proc = Start-Process -FilePath $ExePath -PassThru -WindowStyle Minimized
try {
  Start-Sleep -Seconds $WaitSeconds
  if ($proc.HasExited) {
    $code = $proc.ExitCode
    if ($code -ne 0) {
      throw "QingCode exited early with code $code (expected stay-alive or exit 0)."
    }
    Write-Host "  process exited cleanly with code 0 within ${WaitSeconds}s" -ForegroundColor DarkGray
  } else {
    Write-Host "  process still running after ${WaitSeconds}s - stopping" -ForegroundColor DarkGray
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    # Give the OS a moment; ignore if already gone.
    Start-Sleep -Milliseconds 300
  }
  Write-Host "OK process-start smoke passed" -ForegroundColor Green
} catch {
  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  throw
}
