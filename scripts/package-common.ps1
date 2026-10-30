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

# --- SSH 远端 server 二进制（qingcode-server）打包支持 ---
#
# 运行时查找顺序（src-tauri/src/lib.rs 的 configure_ssh_server_binary_dirs）：
#   QINGCODE_SERVER_DIR → exe 目录/servers → exe 上级/server → resource_dir/servers
# 因此：
#   - Windows 安装包携带 servers/，覆盖安装时与客户端同步更新。
#   - 便携版 exe 不嵌入二进制，使用同目录 servers/（含 manifest.json）。
#   - 离线：release/servers/ 与 QingCode-servers.zip，放到 QingCode.exe 同目录的 servers/。
#   - 在线：ssh.server.autoDownload 按 manifest sha256 从 GitHub Release 下载到缓存目录。
# 二进制由 scripts/build-server.ps1 交叉编译（Linux musl 静态），产物在
# src-tauri/target/server/。
#
# 资源映射语义（已实测）：bundle.resources 的相对路径按 tauri.conf.json 所在目录
# （src-tauri/）解析，因此键 `resources/servers/` 指向 src-tauri/resources/servers/；
# 映射目标是资源目录下的 `servers/`。安装脚本用临时配置显式映射本轮文件，
# 不影响未准备 server 的 tauri dev / 普通 tauri build。

function Resolve-ServerOutputDir {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  # build-server.ps1 固定输出到 src-tauri/target/server（开发模式 exe 在
  # src-tauri/target/{debug,release}/ 下，可被“exe 上级/server”命中）。
  Join-Path $ProjectRoot 'src-tauri\target\server'
}

function Resolve-ServerStagingDir {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  # 必须与 src-tauri/tauri.conf.json 的 bundle.resources 键（resources/servers/）一致。
  Join-Path $ProjectRoot 'src-tauri\resources\servers'
}

function Invoke-ServerBinaryBuild {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [switch]$SkipServer,
    # 逗号分隔的目标架构，空表示 build-server.ps1 的默认值（x86_64,aarch64）。
    [string]$Targets = ''
  )

  if ($SkipServer) {
    Write-Host '  server: reuse existing package after validation (-SkipServer)' -ForegroundColor Yellow
    Get-ServerBinaryFiles -ProjectRoot $ProjectRoot | Out-Null
    return
  }

  $script = Join-Path $ProjectRoot 'scripts\build-server.ps1'
  if (-not (Test-Path -LiteralPath $script)) {
    throw "Server build script not found: $script"
  }
  $pwshArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script)
  if ($Targets) { $pwshArgs += @('-Targets', $Targets) }
  & pwsh @pwshArgs
  if ($LASTEXITCODE -ne 0) {
    throw "build-server.ps1 failed with exit code $LASTEXITCODE."
  }
}

function Get-ServerBinaryFiles {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $src = Resolve-ServerOutputDir -ProjectRoot $ProjectRoot
  if (-not (Test-Path -LiteralPath $src)) {
    throw "Server output directory not found: $src (run scripts/build-server.ps1 first, or drop -SkipServer)"
  }
  $manifestPath = Join-Path $src 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Server manifest missing: $manifestPath (run scripts/build-server.ps1 first, or drop -SkipServer)"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $clientVersion = (Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
  $tauriVersion = (Get-Content (Join-Path $ProjectRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
  foreach ($cargoFile in @('src-tauri/Cargo.toml', 'src-tauri/qingcode-server/Cargo.toml')) {
    $versionLine = Select-String -LiteralPath (Join-Path $ProjectRoot $cargoFile) -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $versionLine -or $versionLine.Matches[0].Groups[1].Value -cne $clientVersion) {
      throw "Server/client version mismatch in $cargoFile (expected $clientVersion)"
    }
  }
  if (-not $clientVersion -or $manifest.version -cne $clientVersion -or $tauriVersion -cne $clientVersion) {
    throw "Server/client version mismatch: manifest=$($manifest.version), client=$clientVersion, tauri=$tauriVersion (rebuild server; drop -SkipServer)"
  }
  $entries = @($manifest.artifacts.PSObject.Properties)
  foreach ($required in @('qingcode-server-x86_64', 'qingcode-server-aarch64')) {
    if ($required -cnotin $entries.Name) { throw "Server manifest missing required artifact: $required" }
  }
  foreach ($entry in $entries) {
    # Only canonical filenames; manifest entries must never escape the package directory.
    if ($entry.Name -cnotmatch '^qingcode-server-(x86_64|aarch64|windows-(x86_64|aarch64)\.exe)$') {
      throw "Invalid server artifact name: $($entry.Name)"
    }
    $file = Get-Item -LiteralPath (Join-Path $src $entry.Name) -ErrorAction Stop
    if ($file.PSIsContainer -or $entry.Value.size -le 0 -or $file.Length -ne $entry.Value.size) {
      throw "Server artifact size mismatch: $($entry.Name)"
    }
    if ($entry.Value.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value.sha256) {
      throw "Server artifact SHA-256 mismatch: $($entry.Name)"
    }
    $file
  }
}

function Copy-ServerBinariesToDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $files = @(Get-ServerBinaryFiles -ProjectRoot $ProjectRoot)
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }
  # A subset build must not carry an older architecture forward into the next package.
  Get-ChildItem -LiteralPath $Destination -File -Filter 'qingcode-server-*' |
    Where-Object { $_.Name -cnotin $files.Name } |
    Remove-Item -Force
  foreach ($file in $files) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $Destination $file.Name) -Force
  }
  Copy-Item -LiteralPath (Join-Path (Resolve-ServerOutputDir -ProjectRoot $ProjectRoot) 'manifest.json') `
    -Destination (Join-Path $Destination 'manifest.json') -Force
  Write-Host ("  server: {0} -> {1}" -f (($files | ForEach-Object { $_.Name }) -join ', '), $Destination) -ForegroundColor DarkGray
  return $files
}

function Publish-ServerBinariesToResourceDir {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  # 安装脚本把清单与本轮二进制逐项映射到 resource_dir/servers。
  # 先清掉上次残留（例如构建中断留下的其它架构），保证进包内容确定。
  Clear-ServerResourceDir -ProjectRoot $ProjectRoot
  $destination = Resolve-ServerStagingDir -ProjectRoot $ProjectRoot
  return (Copy-ServerBinariesToDirectory -ProjectRoot $ProjectRoot -Destination $destination)
}

function Publish-ServerOfflinePack {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $release = Join-Path $ProjectRoot 'release'
  $destination = Join-Path $release 'servers'
  $files = @(Copy-ServerBinariesToDirectory -ProjectRoot $ProjectRoot -Destination $destination)
  if (-not (Test-Path -LiteralPath $release)) {
    New-Item -ItemType Directory -Force -Path $release | Out-Null
  }
  $zip = Join-Path $release 'QingCode-servers.zip'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  $packPaths = @($files | ForEach-Object { Join-Path $destination $_.Name }) + @((Join-Path $destination 'manifest.json'))
  Compress-Archive -LiteralPath $packPaths -DestinationPath $zip -Force
  Write-Host "  offline server pack: $zip" -ForegroundColor DarkGray
}

function Clear-ServerResourceDir {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  # 只删除临时二进制和清单，保留 .gitignore 占位。
  $destination = Resolve-ServerStagingDir -ProjectRoot $ProjectRoot
  if (-not (Test-Path -LiteralPath $destination)) { return }
  $stale = Get-ChildItem -LiteralPath $destination -File -Filter 'qingcode-server-*' -ErrorAction SilentlyContinue
  foreach ($file in $stale) {
    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath (Join-Path $destination 'manifest.json') -Force -ErrorAction SilentlyContinue
}
