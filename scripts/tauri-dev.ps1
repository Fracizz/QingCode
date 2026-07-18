[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# Stop a stale `tauri dev` process tree before touching its debug executable.
# Otherwise its Cargo watcher can immediately respawn qingcode.exe after the
# window is killed, racing the next Cargo build and causing Windows error 5.
function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-StaleTauriDevTree {
  $debugExe = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri\target\debug\qingcode.exe'))
  $debugProcesses = Get-CimInstance Win32_Process -Filter "Name = 'qingcode.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      [System.IO.Path]::GetFullPath($_.ExecutablePath).Equals(
        $debugExe,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    }

  foreach ($debugProcess in $debugProcesses) {
    $ancestor = $debugProcess
    $tauriDevRoot = $null
    for ($depth = 0; $depth -lt 8 -and $ancestor.ParentProcessId; $depth++) {
      $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $($ancestor.ParentProcessId)" -ErrorAction SilentlyContinue
      if (!$ancestor) { break }
      if (
        $ancestor.CommandLine -like '*@tauri-apps*cli*tauri.js*dev*' -or
        $ancestor.CommandLine -like '*@tauri-apps\cli\tauri.js*dev*'
      ) {
        $tauriDevRoot = $ancestor
        break
      }
    }

    if ($tauriDevRoot) {
      Write-Host "Stopping stale Tauri dev process tree (PID $($tauriDevRoot.ProcessId))"
      Stop-ProcessTree -ProcessId $tauriDevRoot.ProcessId
    }
  }
}

# Prefer an uncommon port so Vite/Next defaults (5173/3000) don't collide.
function Get-AvailableDevPort {
  param([int]$StartPort = 38417, [int]$MaxAttempts = 100)
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

# Unlock target\debug\qingcode.exe (and stale windows) from a previous session.
Stop-StaleTauriDevTree
Get-Process -Name 'qingcode', 'QingCode' -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -and (
      $_.Path -like (Join-Path $projectRoot 'src-tauri\target\*') -or
      $_.Path -like (Join-Path $projectRoot 'release\*')
    )
  } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

$devPort = Get-AvailableDevPort
$env:VITE_DEV_PORT = "$devPort"

$devDir = Join-Path $projectRoot '.dev'
New-Item -ItemType Directory -Force -Path $devDir | Out-Null

$overridePath = Join-Path $devDir 'tauri-dev-override.json'
$overrideJson = @{ build = @{ devUrl = "http://127.0.0.1:$devPort" } } | ConvertTo-Json -Depth 3
# Avoid UTF-8 BOM (breaks some Tauri config merges on Windows PowerShell 5).
[System.IO.File]::WriteAllText($overridePath, $overrideJson + "`n", (New-Object System.Text.UTF8Encoding $false))

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
