[CmdletBinding()]
param(
  # Rebuild frontend even when dist looks up to date.
  [switch]$Force,
  # Skip frontend build (Rust-only changes).
  [switch]$SkipFrontend,
  # Skip icon sync from SVG.
  [switch]$SkipIcons,
  # Skip copying to release/ when output already matches the build artifact.
  [switch]$SkipCopy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot 'src-tauri\target\release'
$outDir = Join-Path $projectRoot 'release'
$cargoManifest = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$iconSvg = Join-Path $projectRoot 'public\app-icon-file.svg'
$iconIco = Join-Path $projectRoot 'src-tauri\icons\icon.ico'
$distIndex = Join-Path $projectRoot 'dist\index.html'

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

function Invoke-FrontendBuild {
  Write-Step 'Frontend build'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  pnpm build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm build failed with exit code $LASTEXITCODE."
  }
  Write-Host ("  done in {0:N1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
}

function Invoke-RustReleaseBuild {
  Write-Step 'Rust release build'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  cargo build --release -p qingcode --manifest-path $cargoManifest --features custom-protocol
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed with exit code $LASTEXITCODE."
  }
  Write-Host ("  done in {0:N1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
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

  Write-Step 'Prepare'
  $iconsSynced = Sync-IconsIfNeeded

  $frontendStale = -not $SkipFrontend -and ($Force -or (Test-FrontendStale))
  if ($SkipFrontend) {
    Write-Host '  skip frontend (-SkipFrontend)'
  } elseif ($frontendStale) {
    Invoke-FrontendBuild
  } else {
    Write-Host '  frontend up to date - skipping pnpm build'
  }

  if ($iconsSynced) {
    Write-Host '  icons changed - forcing Rust rebuild for embedded resources'
    Push-Location (Join-Path $projectRoot 'src-tauri')
    try {
      cargo clean -p qingcode --quiet
    } finally {
      Pop-Location
    }
  }

  Invoke-RustReleaseBuild

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

  if ($SkipCopy) {
    Write-Host ""
    Write-Host "OK Build artifact ready (copy skipped)" -ForegroundColor Green
    Write-Host "  $($exe.FullName)"
    Write-Host ("  total {0:N1}s" -f $totalSw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
    return
  }

  Write-Step 'Copy to release/'
  if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
  }

  $versioned = Join-Path $outDir ("{0}_{1}.exe" -f $productName, $version)
  $latest = Join-Path $outDir ("{0}.exe" -f $productName)
  $sourceHash = Get-FileSha256 $exe.FullName

  $latestUpToDate = (Test-Path $latest) -and ((Get-Item $latest).Length -eq $exe.Length) -and ((Get-FileSha256 $latest) -eq $sourceHash)
  $versionedUpToDate = (Test-Path $versioned) -and ((Get-Item $versioned).Length -eq $exe.Length) -and ((Get-FileSha256 $versioned) -eq $sourceHash)

  if ($latestUpToDate -and $versionedUpToDate) {
    Write-Host '  release/ already matches build output - skipping copy'
  } else {
    function Copy-ReleaseExe([string]$From, [string]$To) {
      $temp = "$To.part"
      if (Test-Path $temp) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }
      Copy-Item $From $temp -Force
      if (Test-Path $To) { Remove-Item $To -Force }
      Move-Item $temp $To -Force
    }

    $versionedOk = $false
    $latestOk = $false

    try {
      Copy-ReleaseExe $exe.FullName $versioned
      $versionedOk = $true
    } catch {
      Write-Host "  warning: failed to update $versioned - $_" -ForegroundColor Yellow
    }

    try {
      Copy-ReleaseExe $exe.FullName $latest
      $latestOk = $true
    } catch {
      Write-Host "  warning: failed to update $latest (exe may be running) - $_" -ForegroundColor Yellow
    }

    if (-not $versionedOk -and -not $latestOk) {
      throw "Failed to copy exe to release/. Close any running QingCode.exe and retry."
    }

    if ($latestOk) {
      $latestHash = Get-FileSha256 $latest
      if ($sourceHash -ne $latestHash) {
        throw "Copy verification failed: release exe does not match build output."
      }
    }
  }

  Write-Host ""
  Write-Host "OK portable exe written to release/" -ForegroundColor Green
  Write-Host "  $versioned"
  Write-Host "  $latest"
  Write-Host "  源: $($exe.FullName)"
  Write-Host ("  total {0:N1}s" -f $totalSw.Elapsed.TotalSeconds) -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "Tips: -SkipFrontend (Rust only) · -Force (full rebuild) · install sccache for faster Rust rebuilds" -ForegroundColor DarkGray
} finally {
  Pop-Location
}
