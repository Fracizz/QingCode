# 构建 SSH 远端代理（qingcode-server）的 Linux musl 静态二进制，并放置到主程序可发现的位置。
#
# 用法（在仓库根目录执行）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-server.ps1
# 可选参数：
#   -Targets x86_64,aarch64   目标架构（默认两者都构建）
#   -MuslLinker <path>        显式指定 musl 链接器（默认 rust-lld）
#
# 链接器：Windows PATH 中的 cc 可能是 MinGW，无法链接 Linux musl；本脚本默认
# 使用 rustup 自带的 rust-lld（Rust 为 musl 目标提供自包含的 crt/libc.a）。
# TLS/ring 包含 C 源码，仍需目标 C 编译器和归档器：优先保留已有 CC_<target>/AR_<target>；
# 否则选择 musl-gcc / AArch64 GNU 交叉 GCC，或支持 Linux 目标的 clang + llvm-ar。
# Windows 需安装 LLVM（clang、llvm-ar）；仅有 MinGW 或 rust-lld 不足以编译 Linux TLS。
# 可用 -MuslLinker 显式指定最终链接器路径。
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
    # 显式指定 musl 链接器（默认使用 rust-lld）
    [string]$MuslLinker = "",
    # Windows 上默认再编一份本机 serve 用的 exe。macOS/Linux 的 pwsh 不要编 MSVC。
    [switch]$SkipWindows
)

$ErrorActionPreference = "Stop"

# 定位 rustup 工具链自带的 rust-lld（仅负责最终链接；C 编译器另行配置）。
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

# cc-rs reads both CC_<triple-with-dashes> and CC_<triple_with_underscores>.
# Do not overwrite caller-provided target compilers/archivers; generic Windows
# CC=MinGW is not a Linux cross compiler, so auto-selection is target-specific.
function Configure-MuslCCompiler {
    param([string]$Target, [string]$Arch)
    $suffix = $Target.Replace("-", "_")
    $ccDash = "CC_$Target"
    $ccVar = "CC_$suffix"
    $compiler = [Environment]::GetEnvironmentVariable($ccDash)
    if (-not $compiler) { $compiler = [Environment]::GetEnvironmentVariable($ccVar) }
    if (-not $compiler) {
        $candidates = if ($Arch -eq "x86_64") {
            @("x86_64-linux-musl-gcc", "musl-gcc", "clang")
        } elseif ($Arch -eq "aarch64") {
            @("aarch64-linux-musl-gcc", "aarch64-linux-gnu-gcc", "clang")
        } else { throw "不支持的 Linux 服务器架构：$Arch" }
        foreach ($candidate in $candidates) {
            $command = Get-Command $candidate -ErrorAction SilentlyContinue
            if ($command) { $compiler = $command.Source; break }
        }
        if (-not $compiler) {
            throw "TLS/ring 构建 $Target 需要 C 交叉编译器。Windows 请安装 LLVM（clang + llvm-ar），Linux 请安装 musl-tools / gcc-aarch64-linux-gnu，或设置 $ccVar 与 AR_$suffix。rust-lld 只能链接，不能编译 C 源码。"
        }
        [Environment]::SetEnvironmentVariable($ccVar, $compiler)
    }
    Write-Host "== TLS/ring C 编译器：$compiler ($Target)"

    $resolvedCompiler = Get-Command $compiler -ErrorAction SilentlyContinue
    $compilerPath = if ($resolvedCompiler) { $resolvedCompiler.Source } else { $compiler }
    $compilerName = [System.IO.Path]::GetFileNameWithoutExtension($compilerPath)
    if ($compilerName -eq "clang-cl") {
        throw "clang-cl 使用 MSVC 驱动模式，不能作为 Linux musl 的 C 编译器；请将 CC_$suffix 设置为 clang（并配置 llvm-ar）。"
    }
    $isClang = $compilerName -like "clang*"
    $extraFlags = ""
    if ($isClang) {
        # Clang's own stddef/stdint headers plus ring's freestanding helpers avoid
        # accidentally including the Windows/macOS host C library headers.
        $extraFlags = "--target=$Target -ffreestanding -nostdlibinc -DRING_CORE_NOSTDLIBINC=1"
    } elseif ($Arch -eq "aarch64" -and $compilerName -like "*linux-gnu-gcc*") {
        # Verified with AArch64 GNU GCC + rust-lld + Rust's musl crt/libc.
        $extraFlags = "-ffreestanding -DRING_CORE_NOSTDLIBINC=1"
    }
    if ($extraFlags) {
        $flagsVar = "CFLAGS_$suffix"
        $flagsDash = "CFLAGS_$Target"
        $flags = [Environment]::GetEnvironmentVariable($flagsDash)
        if ($flags) { $flagsVar = $flagsDash } else { $flags = [Environment]::GetEnvironmentVariable($flagsVar) }
        [Environment]::SetEnvironmentVariable($flagsVar, ("$flags $extraFlags").Trim())
    }

    $arVar = "AR_$suffix"
    if (-not [Environment]::GetEnvironmentVariable("AR_$Target") -and -not [Environment]::GetEnvironmentVariable($arVar)) {
        $archivers = if ($isClang) { @("llvm-ar") } elseif ($Arch -eq "aarch64") {
            @("aarch64-linux-musl-ar", "aarch64-linux-gnu-ar", "llvm-ar")
        } else { @("x86_64-linux-musl-ar", "ar", "llvm-ar") }
        $archiveTool = $null
        $compilerDirectory = Split-Path -Parent $compilerPath
        if ($isClang -and $compilerDirectory) {
            foreach ($name in @("llvm-ar.exe", "llvm-ar")) {
                $sibling = Join-Path $compilerDirectory $name
                if (Test-Path $sibling) { $archiveTool = $sibling; break }
            }
        }
        if (-not $archiveTool) {
            foreach ($candidate in $archivers) {
                $command = Get-Command $candidate -ErrorAction SilentlyContinue
                if ($command) { $archiveTool = $command.Source; break }
            }
        }
        if (-not $archiveTool) {
            throw "缺少 $Target 的 C 归档器；请安装 llvm-ar / 对应交叉 binutils，或设置 $arVar。"
        }
        [Environment]::SetEnvironmentVariable($arVar, $archiveTool)
    }
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

        Configure-MuslCCompiler -Target $target -Arch $arch

        # Final linking uses Rust's musl crt/libc and rust-lld on every host.
        # C compilation is configured separately above; a GNU host linker cannot
        # link AArch64 or Windows-hosted Linux outputs merely because cc exists.
        $linkerVar = "CARGO_TARGET_" + $target.ToUpper().Replace("-", "_") + "_LINKER"
        $linker = $MuslLinker
        if (-not $linker) { $linker = [Environment]::GetEnvironmentVariable($linkerVar) }
        if (-not $linker) {
            $linker = Resolve-RustLld
            if (-not $linker) { throw "未找到 rust-lld；请修复 Rust 工具链或传入 -MuslLinker <兼容目标的链接器>" }
        }
        Write-Host "== musl 链接器：$linker"
        [Environment]::SetEnvironmentVariable($linkerVar, $linker)

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
