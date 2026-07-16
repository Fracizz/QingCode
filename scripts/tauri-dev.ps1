[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-AvailableDevPort {
  param([int]$StartPort = 5173, [int]$MaxAttempts = 100)
  for ($port = $StartPort; $port -lt ($StartPort + $MaxAttempts); $port++) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    try {
      $listener.Start()
      $listener.Stop()
      return $port
    } catch {
      if ($listener) {
        try { $listener.Stop() } catch {}
      }
    }
  }
  throw "No free dev port found in range $StartPort..$($StartPort + $MaxAttempts - 1)."
}

$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

$devPort = Get-AvailableDevPort
$env:VITE_DEV_PORT = "$devPort"

$devDir = Join-Path $projectRoot '.dev'
New-Item -ItemType Directory -Force -Path $devDir | Out-Null

$overridePath = Join-Path $devDir 'tauri-dev-override.json'
@{ build = @{ devUrl = "http://127.0.0.1:$devPort" } } | ConvertTo-Json -Depth 3 | Set-Content $overridePath -Encoding UTF8

Write-Host "Using dev server port $devPort"

Push-Location $projectRoot
try {
  pnpm tauri dev --config $overridePath
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri dev failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
