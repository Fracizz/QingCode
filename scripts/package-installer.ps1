# Build QingCode Windows NSIS installer (.exe setup) via Tauri.
# Usage: ./scripts/package-installer.ps1 [-Force] [-SkipFrontend] [-Target <triple>]
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipFrontend,
  [switch]$SkipIcons,
  # Optional Rust target triple (e.g. aarch64-pc-windows-msvc).
  [string]$Target = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'package-common.ps1')

$outDir = Join-Path $projectRoot 'release'
$iconSvg = Join-Path $projectRoot 'public\app-icon-file.svg'
$iconIco = Join-Path $projectRoot 'src-tauri\icons\icon.ico'
$distIndex = Join-Path $projectRoot 'dist\index.html'
$bundleDir = Resolve-CargoBundleDir -ProjectRoot $projectRoot -Target $Target

$archSuffix = switch -Regex ($Target) {
  'aarch64-pc-windows' { '-windows-arm64' }
  'x86_64-pc-windows' { '-windows-x64' }
  default { '' }
}

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "> $Message" -ForegroundColor Cyan
}

function Sync-IconsIfNeeded {
  if ($SkipIcons) {
    Write-Host '  skip icons (-SkipIcons)'
    return $false
  }
  if (-not (Test-Path $iconSvg)) {
    throw "Icon source not found: $iconSvg"
  }
  if (-not (Test-Path $iconIco) -or ((Get-Item $iconSvg).LastWriteTime -gt (Get-Item $iconIco).LastWriteTime)) {
    Write-Host '  syncing icons from SVG...'
    pnpm icon:sync
    if ($LASTEXITCODE -ne 0) {
      throw "icon:sync failed with exit code $LASTEXITCODE."
    }
    return $true
  }
  Write-Host '  icons up to date'
  return $false
}

Push-Location $projectRoot
try {
  $totalSw = [Diagnostics.Stopwatch]::StartNew()

  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if (($env:Path -split ';') -notcontains $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
  }

  if (Get-Command sccache -ErrorAction SilentlyContinue) {
    $env:RUSTC_WRAPPER = 'sccache'
    Write-Host 'Using sccache for Rust compilation cache.' -ForegroundColor DarkGray
  }

  if (-not $Target) {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64') {
      throw "本机打包仅支持 Windows x64。当前为 ARM64，请用 CI 或 pnpm package:installer:arm64 / package:exe:arm64。"
    }
    if ($arch -notin @('AMD64', 'x86')) {
      Write-Host "  warning: unexpected PROCESSOR_ARCHITECTURE=$arch; continuing as host x64 build." -ForegroundColor Yellow
    }
  }

  Write-Step 'Prepare (Windows x64 NSIS installer)'
  $iconsSynced = Sync-IconsIfNeeded

  $frontendRebuilt = $false
  if ($SkipFrontend) {
    Write-Host '  skip frontend (-SkipFrontend)'
    if (-not (Test-Path $distIndex)) {
      throw 'dist/ missing; run without -SkipFrontend first.'
    }
  } elseif ($Force -or (Test-FrontendStale -ProjectRoot $projectRoot)) {
    Write-Step 'Frontend build'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    # tauri build also runs beforeBuildCommand; build once here so stale checks work.
    pnpm build
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm build failed with exit code $LASTEXITCODE."
    }
    Write-Host ("  done in {0:N1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
    $frontendRebuilt = $true
  } else {
    Write-Host '  frontend up to date - skipping pnpm build'
  }

  if ($iconsSynced -or $frontendRebuilt -or $Force) {
    Invoke-ForceQingcodeEmbedRebuild -ProjectRoot $projectRoot -Target $Target
  }

  Write-Step 'Tauri NSIS installer build'
  if ($Target) {
    Write-Host "  target: $Target" -ForegroundColor DarkGray
  }
  if ($env:CARGO_TARGET_DIR) {
    Write-Host "  CARGO_TARGET_DIR: $env:CARGO_TARGET_DIR" -ForegroundColor DarkGray
    Write-Host "  bundle dir: $bundleDir" -ForegroundColor DarkGray
  }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # Skip beforeBuildCommand when dist is already fresh to avoid a second full frontend build.
  $tauriArgs = @('tauri', 'build', '--bundles', 'nsis', '--ci')
  if ($Target) {
    $tauriArgs += @('--target', $Target)
  }
  # Pass override via file: PowerShell strips quotes from inline JSON in @args.
  if (-not $Force -and -not (Test-FrontendStale -ProjectRoot $projectRoot) -and (Test-Path $distIndex)) {
    $devDir = Join-Path $projectRoot '.dev'
    if (-not (Test-Path $devDir)) {
      New-Item -ItemType Directory -Path $devDir | Out-Null
    }
    $skipFrontendConfig = Join-Path $devDir 'tauri-package-override.json'
    $overrideJson = (@{ build = @{ beforeBuildCommand = '' } } | ConvertTo-Json -Depth 3) + "`n"
    [System.IO.File]::WriteAllText(
      $skipFrontendConfig,
      $overrideJson,
      (New-Object System.Text.UTF8Encoding $false)
    )
    $tauriArgs += @('--config', $skipFrontendConfig)
  }
  & pnpm @tauriArgs
  if ($LASTEXITCODE -ne 0) {
    throw "tauri build --bundles nsis failed with exit code $LASTEXITCODE."
  }
  Write-Host ("  done in {0:N1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray

  $conf = Get-Content (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
  $productName = $conf.productName
  $version = $conf.version

  $nsisDir = Join-Path $bundleDir 'nsis'
  if (-not (Test-Path $nsisDir)) {
    throw "NSIS bundle directory not found: $nsisDir"
  }

  $setup = Get-ChildItem -Path $nsisDir -Filter '*.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $setup) {
    throw "Build completed but no NSIS installer .exe found in $nsisDir."
  }

  Write-Step 'Copy to release/'
  if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
  }

  $versioned = Join-Path $outDir ("{0}_{1}{2}-setup.exe" -f $productName, $version, $archSuffix)
  $latest = if ($archSuffix) {
    Join-Path $outDir ("{0}{1}-setup.exe" -f $productName, $archSuffix)
  } else {
    Join-Path $outDir ("{0}-setup.exe" -f $productName)
  }

  Copy-Item $setup.FullName $versioned -Force
  Copy-Item $setup.FullName $latest -Force

  Write-Host ""
  Write-Host "OK NSIS installer written to release/" -ForegroundColor Green
  Write-Host "  $versioned"
  Write-Host "  $latest"
  Write-Host "  源: $($setup.FullName)"
  Write-Host ("  total {0:N1}s" -f $totalSw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "Install notes: Start Menu shortcut always; desktop shortcut checked by default on finish page." -ForegroundColor DarkGray
  Write-Host "Tips: pnpm package:exe (portable) · -SkipFrontend · -Force · ARM64/macOS via CI" -ForegroundColor DarkGray
} finally {
  Pop-Location
}
