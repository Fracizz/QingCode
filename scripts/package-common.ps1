# Shared helpers for Windows packaging scripts (package-exe / package-installer).

function Resolve-CargoReleaseDir {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$Target = ''
  )

  # Cursor/CI may redirect Cargo output via CARGO_TARGET_DIR. When set, cargo
  # always writes there — do not fall back to src-tauri/target (often stale).
  if ($env:CARGO_TARGET_DIR) {
    $cargoTarget = $env:CARGO_TARGET_DIR.TrimEnd('\', '/')
    if ($Target) {
      return (Join-Path $cargoTarget "$Target\release")
    }
    return (Join-Path $cargoTarget 'release')
  }

  if ($Target) {
    return (Join-Path $ProjectRoot "src-tauri\target\$Target\release")
  }
  return (Join-Path $ProjectRoot 'src-tauri\target\release')
}

function Resolve-CargoBundleDir {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$Target = ''
  )
  Join-Path (Resolve-CargoReleaseDir -ProjectRoot $ProjectRoot -Target $Target) 'bundle'
}

function Write-FrontendBuildPlan {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [switch]$SkipFrontend,
    [switch]$Force
  )

  if ($SkipFrontend) {
    Write-Host '  frontend: skipped (-SkipFrontend)' -ForegroundColor Yellow
    return
  }
  if ($Force) {
    Write-Host '  frontend: will rebuild (-Force)' -ForegroundColor DarkGray
    return
  }
  if (Test-FrontendStale -ProjectRoot $ProjectRoot) {
    Write-Host '  frontend: stale — will run pnpm build' -ForegroundColor DarkGray
    return
  }
  Write-Host '  frontend: up to date — skipping pnpm build (use -Force to rebuild)' -ForegroundColor DarkGray
}

function Test-FrontendStale {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  $distIndex = Join-Path $ProjectRoot 'dist\index.html'
  if (-not (Test-Path $distIndex)) { return $true }

  $distTime = (Get-Item $distIndex).LastWriteTimeUtc
  $watchRoots = @(
    (Join-Path $ProjectRoot 'index.html'),
    (Join-Path $ProjectRoot 'vite.config.ts'),
    (Join-Path $ProjectRoot 'package.json'),
    (Join-Path $ProjectRoot 'tsconfig.json'),
    (Join-Path $ProjectRoot 'tsconfig.node.json'),
    (Join-Path $ProjectRoot 'public'),
    (Join-Path $ProjectRoot 'src\locales')
  )

  foreach ($path in $watchRoots) {
    if (-not (Test-Path $path)) { continue }
    $item = Get-Item $path
    if ($item.PSIsContainer) {
      $newerInDir = Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
        Select-Object -First 1
      if ($newerInDir) { return $true }
    } elseif ($item.LastWriteTimeUtc -gt $distTime) {
      return $true
    }
  }

  $srcRoot = Join-Path $ProjectRoot 'src'
  if (-not (Test-Path $srcRoot)) { return $true }

  # Include locales JSON and other non-TS assets that affect the production bundle.
  $newer = Get-ChildItem -Path $srcRoot -Recurse -File -Include *.ts,*.tsx,*.css,*.json,*.svg |
    Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
    Select-Object -First 1
  return [bool]$newer
}

function Stop-LockingQingcodeProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  $targetRoot = Join-Path $ProjectRoot 'src-tauri\target'
  $releaseRoot = Join-Path $ProjectRoot 'release'
  $locking = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @('qingcode.exe', 'QingCode.exe') -and
      $_.ExecutablePath -and (
        $_.ExecutablePath -like (Join-Path $targetRoot '*') -or
        $_.ExecutablePath -like (Join-Path $releaseRoot '*')
      )
    }

  foreach ($proc in $locking) {
    Write-Host "  stopping locking process: $($proc.ExecutablePath) (PID $($proc.ProcessId))" -ForegroundColor DarkGray
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($locking) {
    Start-Sleep -Milliseconds 400
  }
}

function Invoke-ForceQingcodeEmbedRebuild {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$Target = ''
  )

  # Frontend Dist changes are easy for Cargo to miss (dir mtime). Clean the
  # release package so the next --release build re-runs build.rs / re-embeds assets.
  # Use --release only: a full clean also deletes target/debug and fails while
  # `tauri dev` still holds qingcode.exe (Windows error 5).
  Write-Host '  frontend updated - forcing qingcode rebuild to re-embed dist/' -ForegroundColor DarkGray
  $manifest = Join-Path $ProjectRoot 'src-tauri\Cargo.toml'
  $cleanArgs = @('clean', '-p', 'qingcode', '--release', '--manifest-path', $manifest, '--quiet')
  if ($Target) {
    $cleanArgs += @('--target', $Target)
  }

  Stop-LockingQingcodeProcesses -ProjectRoot $ProjectRoot
  & cargo @cleanArgs
  if ($LASTEXITCODE -ne 0) {
    Stop-LockingQingcodeProcesses -ProjectRoot $ProjectRoot
    & cargo @cleanArgs
  }
  if ($LASTEXITCODE -ne 0) {
    throw "cargo clean -p qingcode --release failed with exit code $LASTEXITCODE. Close QingCode or tauri dev and retry."
  }
}
