# 构建 SSH 远端代理（qingcode-server）的 Linux musl 静态二进制，并放置到主程序可发现的位置。
#
# 用法（在仓库根目录执行）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-server.ps1
# 可选参数：
#   -Targets x86_64,aarch64   目标架构（默认两者都构建）
#   -MuslLinker <path>        显式指定 musl 链接器（默认自动探测 cc / rust-lld）
#
# 链接器：cargo 的 musl 目标默认调用 `cc`，Windows 上没有 C 工具链时链接会失败
# （error: linker `cc` not found）。本脚本在 PATH 中找不到 `cc` 时会自动改用 rustup
# 自带的 rust-lld（Rust 为 musl 目标提供自包含的 crt/libc.a，纯 Rust 依赖无需 C 交叉
# 编译器），也可用 -MuslLinker 显式指定路径覆盖。
#
# 产物查找顺序（src-tauri/src/lib.rs setup）：
#   QINGCODE_SERVER_DIR 环境变量 → exe 目录（/servers）→ exe 目录上级（/server）→ 资源目录（/servers）
# 开发模式下 exe 位于 src-tauri/target/{debug,release}/，因此默认把产物复制到
# src-tauri/target/server/，`pnpm tauri:dev` 都能自动发现（无需再打包一步）。
# 安装包不再内置这些二进制。scripts/package-installer.ps1 与 package-exe.ps1
# 把产物放到 release/servers/（离线），客户端也可按 manifest 从 GitHub Release 在线下载。
#
# 完整性清单（设计 §4.2/§8.3）：构建结束后对本轮产物逐一计算 sha256 与大小，
# 写入 src-tauri/target/server/manifest.json。客户端部署前先 SFTP 拉取 manifest，
# 再校验二进制摘要一致后才信任安装（配合 `qingcode-server self-check
# --expect-sha256 <hex>` 做远端复核）。manifest 只记录本轮构建的产物：
# 用 -Targets 子集构建时，清单里就只有对应条目。

param(
    [string]$Targets = "x86_64,aarch64",
    # 显式指定 musl 链接器（默认：PATH 有 cc 则交给 cargo，否则自动用 rust-lld）
    [string]$MuslLinker = "",
    # Windows 上默认再编一份本机 serve 用的 exe。macOS/Linux 的 pwsh 不要编 MSVC。
    [switch]$SkipWindows
)

$ErrorActionPreference = "Stop"

# 定位 rustup 工具链自带的 rust-lld（musl 自包含链接只需链接器驱动）。
function Resolve-RustLld {
    $sysroot = (& rustc --print sysroot) 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $sysroot) { return $null }
    $hostLine = (& rustc -vV) | Where-Object { $_ -like "host:*" }
    if (-not $hostLine) { return $null }
    $hostTriple = $hostLine.Substring(5).Trim()
    foreach ($name in @("rust-lld.exe", "rust-lld")) {
        $candidate = Join-Path (Join-Path (Join-Path (Join-Path $sysroot "lib") "rustlib") $hostTriple) ("bin/$name")
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $repoRoot "src-tauri")

try {
    $outDir = Join-Path (Get-Location) "target\server"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    # CI / IDE 可能用 CARGO_TARGET_DIR 重定向 cargo 输出，产物位置随之改变。
    $cargoTargetDir = $env:CARGO_TARGET_DIR
    if ($cargoTargetDir) {
        if (-not [System.IO.Path]::IsPathRooted($cargoTargetDir)) {
            $cargoTargetDir = Join-Path (Get-Location) $cargoTargetDir
        }
    } else {
        $cargoTargetDir = Join-Path (Get-Location) "target"
    }

    # manifest 只记录本轮构建的产物（见文件头注释）。
    $artifacts = [ordered]@{}

    foreach ($arch in $Targets.Split(",")) {
        $arch = $arch.Trim()
        if (-not $arch) { continue }
        $target = "$arch-unknown-linux-musl"
        Write-Host "== rustup target add $target"
        rustup target add $target
        if ($LASTEXITCODE -ne 0) { throw "rustup target add $target 失败" }

        # musl 链接器：显式参数 > 已有环境变量 > PATH 里的 cc > rust-lld。
        $linkerVar = "CARGO_TARGET_" + $target.ToUpper().Replace("-", "_") + "_LINKER"
        $linker = $MuslLinker
        if (-not $linker) { $linker = [Environment]::GetEnvironmentVariable($linkerVar) }
        if (-not $linker -and -not (Get-Command cc -ErrorAction SilentlyContinue)) {
            $linker = Resolve-RustLld
            if (-not $linker) {
                throw "未找到 C 链接器 cc，也没有可用的 rust-lld；请安装 C 工具链或传入 -MuslLinker <path>"
            }
            Write-Host "== PATH 中没有 cc，改用 rust-lld：$linker"
        }
        if ($linker) { [Environment]::SetEnvironmentVariable($linkerVar, $linker) }

        Write-Host "== cargo build -p qingcode-server --release --target $target"
        cargo build -p qingcode-server --release --target $target
        if ($LASTEXITCODE -ne 0) { throw "构建 $target 失败" }

        $bin = Join-Path $cargoTargetDir "$target\release\qingcode-server"
        if (-not (Test-Path $bin)) { throw "未找到构建产物：$bin" }
        $dest = Join-Path $outDir "qingcode-server-$arch"
        Copy-Item -Force $bin $dest
        Write-Host "== 已复制：$dest ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)"

        # PS 5.1 的 Get-FileHash 默认即 SHA256；统一小写，与 self-check 的输出一致。
        $hash = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLowerInvariant()
        $artifacts["qingcode-server-$arch"] = [ordered]@{
            sha256 = $hash
            size   = (Get-Item $dest).Length
        }
    }

    if (-not $SkipWindows -and $env:OS -eq "Windows_NT") {
        Write-Host "== cargo build -p qingcode-server --release (windows serve)"
        cargo build -p qingcode-server --release
        if ($LASTEXITCODE -ne 0) { throw "构建 Windows server 失败" }
        $winBin = Join-Path $cargoTargetDir "release\qingcode-server.exe"
        if (-not (Test-Path $winBin)) { throw "未找到 Windows 产物：$winBin" }
        $hostLine = (& rustc -vV) | Where-Object { $_ -like "host:*" }
        $hostTriple = if ($hostLine) { $hostLine.Substring(5).Trim() } else { "" }
        $winArch = if ($hostTriple -like "aarch64*") { "aarch64" } else { "x86_64" }
        $winName = "qingcode-server-windows-$winArch.exe"
        $winDest = Join-Path $outDir $winName
        Copy-Item -Force $winBin $winDest
        Write-Host "== 已复制：$winDest ($([math]::Round((Get-Item $winDest).Length / 1MB, 1)) MB)"
        $winHash = (Get-FileHash -Algorithm SHA256 $winDest).Hash.ToLowerInvariant()
        $artifacts[$winName] = [ordered]@{
            sha256 = $winHash
            size   = (Get-Item $winDest).Length
        }
    }

    # 版本号与 SERVER_VERSION 同源：直接从 qingcode-server/Cargo.toml 读取
    # （lib.rs 的 SERVER_VERSION = CARGO_PKG_VERSION = 该文件 version 字段）。
    $versionLine = Select-String -Path (Join-Path (Get-Location) "qingcode-server\Cargo.toml") `
        -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $versionLine) { throw "无法从 qingcode-server/Cargo.toml 读取版本号" }
    $serverVersion = $versionLine.Matches[0].Groups[1].Value

    $manifest = [ordered]@{
        version   = $serverVersion
        artifacts = $artifacts
    }
    $manifestPath = Join-Path $outDir "manifest.json"
    # WriteAllText 用无 BOM 的 UTF-8，避免远端 shell/工具把 BOM 当内容。
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5) + "`n")
    Write-Host "== 已生成 manifest（版本 $serverVersion）：$manifestPath"

    Write-Host "完成。产物目录：$outDir"
}
finally {
    Pop-Location
}
