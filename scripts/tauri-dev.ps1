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
    }
    catch {
      if ($listener) {
        try { $listener.Stop() } catch {}
      }
      continue
    }
    $listener.Stop()
    return $port
  }
  throw "No free dev port found in range $StartPort..$($StartPort + $MaxAttempts - 1)."
}

function Wait-DevServer {
  param(
    [int]$Port,
    [System.Diagnostics.Process]$ViteProcess,
    [int]$TimeoutMs = 45000
  )

  $deadline = [Environment]::TickCount64 + $TimeoutMs
  while ([Environment]::TickCount64 -lt $deadline) {
    if ($ViteProcess.HasExited) {
      throw "Vite exited early with code $($ViteProcess.ExitCode) before becoming ready."
    }
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $client.Connect([System.Net.IPAddress]::Loopback, $Port)
      $client.Close()
      return
    }
    catch {
      Start-Sleep -Milliseconds 200
    }
  }
  throw "Vite did not become ready on 127.0.0.1:$Port within ${TimeoutMs}ms."
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
# On Windows, Tauri hosts beforeDevCommand via `cmd /C`. That process often
# exits with -1 shortly after the app window opens, tearing down `tauri dev`
# even though Vite was healthy. Own Vite in this script and clear the hook.
$overrideJson = @{
  build = @{
    devUrl = "http://127.0.0.1:$devPort"
    beforeDevCommand = ''
  }
} | ConvertTo-Json -Depth 3
# Avoid UTF-8 BOM (breaks some Tauri config merges on Windows PowerShell 5).
[System.IO.File]::WriteAllText($overridePath, $overrideJson + "`n", (New-Object System.Text.UTF8Encoding $false))

Write-Host "Using dev server port $devPort"

$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $pnpm) { $pnpm = (Get-Command pnpm).Source }

$viteProcess = $null
Push-Location $projectRoot
try {
  Write-Host "Starting Vite outside Tauri beforeDevCommand..."
  $viteProcess = Start-Process `
    -FilePath $pnpm `
    -ArgumentList @('exec', 'vite', '--strictPort', '--host', '127.0.0.1') `
    -WorkingDirectory $projectRoot `
    -PassThru `
    -NoNewWindow

  Wait-DevServer -Port $devPort -ViteProcess $viteProcess
  Write-Host "Vite ready at http://127.0.0.1:$devPort"

  pnpm tauri dev --config $overridePath
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri dev failed with exit code $LASTEXITCODE."
  }
}
finally {
  if ($viteProcess -and -not $viteProcess.HasExited) {
    Write-Host "Stopping Vite (PID $($viteProcess.Id))"
    Stop-ProcessTree -ProcessId $viteProcess.Id
  }
  Pop-Location
}
