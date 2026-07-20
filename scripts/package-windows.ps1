# Local Windows x64 packaging: portable exe + NSIS installer in one pass.
# Usage: ./scripts/package-windows.ps1 [-Force] [-SkipFrontend] [-SkipIcons]
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipFrontend,
  [switch]$SkipIcons
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $projectRoot 'release'
$iconSvg = Join-Path $projectRoot 'public\app-icon-file.svg'
$iconIco = Join-Path $projectRoot 'src-tauri\icons\icon.ico'
$distIndex = Join-Path $projectRoot 'dist\index.html'
$releaseDir = Join-Path $projectRoot 'src-tauri\target\release'
$bundleDir = Join-Path $releaseDir 'bundle'

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "> $Message" -ForegroundColor Cyan
}

function Get-FileSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } finally {
    $stream.Dispose()
  }
}

function Test-FrontendStale {
  if (-not (Test-Path $distIndex)) { return $true }

  $distTime = (Get-Item $distIndex).LastWriteTimeUtc
  $watchRoots = @(
    (Join-Path $projectRoot 'index.html'),
    (Join-Path $projectRoot 'vite.config.ts'),
    (Join-Path $projectRoot 'package.json'),
    (Join-Path $projectRoot 'tsconfig.json'),
    (Join-Path $projectRoot 'tsconfig.node.json'),
    (Join-Path $projectRoot 'public')
  )

  foreach ($path in $watchRoots) {
    if (-not (Test-Path $path)) { continue }
    if ((Get-Item $path).LastWriteTimeUtc -gt $distTime) { return $true }
  }

  $srcRoot = Join-Path $projectRoot 'src'
  if (-not (Test-Path $srcRoot)) { return $true }

  $newer = Get-ChildItem -Path $srcRoot -Recurse -File -Include *.ts,*.tsx,*.css |
    Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
    Select-Object -First 1
  return [bool]$newer
}

function Sync-IconsIfNeeded {
  if ($SkipIcons) {
    Write-Host '  skip icons (-SkipIcons)'
    return
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
    return
  }
  Write-Host '  icons up to date'
}

function Copy-ReleaseFile([string]$From, [string]$To) {
  $temp = "$To.part"
  if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
  Copy-Item $From $temp -Force
  if (Test-Path $To) { Remove-Item $To -Force }
  Move-Item $temp $To -Force
}

# Local packaging is x64 only (AMD64). ARM64 / macOS stay on CI.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') {
  throw "本机打包仅支持 Windows x64。当前为 ARM64，请用 CI 或 pnpm package:exe:arm64 / package:installer:arm64。"
}
if ($arch -notin @('AMD64', 'x86')) {
  Write-Host "  warning: unexpected PROCESSOR_ARCHITECTURE=$arch; continuing as host x64 build." -ForegroundColor Yellow
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

  Write-Step 'Prepare (Windows x64 portable + installer)'
  Sync-IconsIfNeeded

  if ($SkipFrontend) {
    Write-Host '  skip frontend (-SkipFrontend)'
    if (-not (Test-Path $distIndex)) {
      throw 'dist/ missing; run without -SkipFrontend first.'
    }
  } elseif ($Force -or (Test-FrontendStale)) {
    Write-Step 'Frontend build'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    pnpm build
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm build failed with exit code $LASTEXITCODE."
    }
    Write-Host ("  done in {0:N1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
  } else {
    Write-Host '  frontend up to date - skipping pnpm build'
  }

  Write-Step 'Tauri release build (NSIS + portable binary)'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # One Rust build produces both the app exe and the NSIS setup.
  $tauriArgs = @('tauri', 'build', '--bundles', 'nsis', '--ci')
  # Pass override via file: PowerShell strips quotes from inline JSON in @args.
  if (-not $Force -and -not (Test-FrontendStale) -and (Test-Path $distIndex)) {
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
  $base = $productName.ToLower()

  $exe = Get-ChildItem -Path $releaseDir -Filter '*.exe' -File |
    Where-Object { $_.BaseName.ToLower() -eq $base } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $exe) {
    throw "Build completed but no '$base.exe' found in $releaseDir."
  }

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

  $portableVersioned = Join-Path $outDir ("{0}_{1}.exe" -f $productName, $version)
  $portableLatest = Join-Path $outDir ("{0}.exe" -f $productName)
  $setupVersioned = Join-Path $outDir ("{0}_{1}-setup.exe" -f $productName, $version)
  $setupLatest = Join-Path $outDir ("{0}-setup.exe" -f $productName)

  try {
    Copy-ReleaseFile $exe.FullName $portableVersioned
    Copy-ReleaseFile $exe.FullName $portableLatest
  } catch {
    throw "Failed to copy portable exe to release/. Close any running QingCode.exe and retry. $_"
  }

  Copy-Item $setup.FullName $setupVersioned -Force
  Copy-Item $setup.FullName $setupLatest -Force

  $portableHash = Get-FileSha256 $portableLatest
  $sourceHash = Get-FileSha256 $exe.FullName
  if ($portableHash -ne $sourceHash) {
    throw 'Copy verification failed: portable release exe does not match build output.'
  }

  Write-Host ""
  Write-Host "OK Windows x64 packages written to release/" -ForegroundColor Green
  Write-Host "  portable: $portableVersioned"
  Write-Host "            $portableLatest"
  Write-Host "  setup:    $setupVersioned"
  Write-Host "            $setupLatest"
  Write-Host ("  total {0:N1}s" -f $totalSw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "Tips: pnpm package (this) · -SkipFrontend · -Force · ARM64/macOS via CI" -ForegroundColor DarkGray
} finally {
  Pop-Location
}
