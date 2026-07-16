[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot 'src-tauri\target\release'
$outDir = Join-Path $projectRoot 'release'

function Get-FileSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } finally {
    $stream.Dispose()
  }
}

Push-Location $projectRoot
try {
  # 确保能用 cargo
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if (($env:Path -split ';') -notcontains $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
  }

  $iconIco = Join-Path $projectRoot 'src-tauri\icons\icon.ico'
  $targetExe = Join-Path $releaseDir 'qingcode.exe'
  if ((Test-Path $iconIco) -and ((-not (Test-Path $targetExe)) -or ((Get-Item $iconIco).LastWriteTime -gt (Get-Item $targetExe).LastWriteTime))) {
    Write-Host 'Icons newer than exe — cleaning qingcode package to re-embed icon...'
    Push-Location (Join-Path $projectRoot 'src-tauri')
    try {
      cargo clean -p qingcode --quiet
    } finally {
      Pop-Location
    }
  }

  # 单文件可执行版：--no-bundle 只产出 target\release\<name>.exe，不生成安装包
  npx --no-install tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE."
  }

  # 读 productName / version
  $conf = Get-Content (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
  $productName = $conf.productName
  $version = $conf.version

  # 找到构建出的 exe（大小写不敏感，取最新）
  $base = $productName.ToLower()
  $exe = Get-ChildItem -Path $releaseDir -Filter '*.exe' -File |
    Where-Object { $_.BaseName.ToLower() -eq $base } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $exe) {
    throw "Build completed but no '$base.exe' found in $releaseDir."
  }

  if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
  }

  # 1) 带版本号归档
  $versioned = Join-Path $outDir ("{0}_{1}.exe" -f $productName, $version)
  Copy-Item $exe.FullName $versioned -Force
  # 2) 固定名 latest
  $latest = Join-Path $outDir ("{0}.exe" -f $productName)
  Copy-Item $exe.FullName $latest -Force

  $sourceHash = Get-FileSha256 $exe.FullName
  $latestHash = Get-FileSha256 $latest
  $versionedHash = Get-FileSha256 $versioned
  if ($sourceHash -ne $latestHash -or $sourceHash -ne $versionedHash) {
    throw "Copy verification failed: release exe does not match build output."
  }

  Write-Host ""
  Write-Host "✓ 单文件 exe 已输出到 release/" -ForegroundColor Green
  Write-Host "  $versioned"
  Write-Host "  $latest"
  Write-Host "  源: $($exe.FullName)"
} finally {
  Pop-Location
}
