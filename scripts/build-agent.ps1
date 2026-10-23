# 构建 SSH 远端代理（qingcode-agent）的 Linux musl 静态二进制，并放置到主程序可发现的位置。
#
# 用法（在仓库根目录执行）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File ./scripts/build-agent.ps1
# 可选参数：
#   -Targets x86_64,aarch64   目标架构（默认两者都构建）
#   -SkipHostCheck            跳过 host 目标构建校验
#
# 产物查找顺序（src-tauri/src/lib.rs setup）：
#   QINGCODE_AGENT_DIR 环境变量 → exe 目录（/agents）→ exe 目录上级（/agent）→ 资源目录（/agents）
# 开发模式下 exe 位于 src-tauri/target/{debug,release}/，因此默认把产物复制到
# src-tauri/target/agent/，`pnpm tauri:dev` / 打包产物都能自动发现。
# 发布打包脚本（package-installer.ps1）可把该目录一并复制进安装包（后续接入）。

param(
    [string]$Targets = "x86_64,aarch64"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $repoRoot "src-tauri")

try {
    $outDir = Join-Path (Get-Location) "target\agent"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    foreach ($arch in $Targets.Split(",")) {
        $arch = $arch.Trim()
        if (-not $arch) { continue }
        $target = "$arch-unknown-linux-musl"
        Write-Host "== rustup target add $target"
        rustup target add $target
        if ($LASTEXITCODE -ne 0) { throw "rustup target add $target 失败" }

        Write-Host "== cargo build -p qingcode-agent --release --target $target"
        cargo build -p qingcode-agent --release --target $target
        if ($LASTEXITCODE -ne 0) { throw "构建 $target 失败" }

        $bin = Join-Path (Get-Location) "target\$target\release\qingcode-agent"
        if (-not (Test-Path $bin)) { throw "未找到构建产物：$bin" }
        $dest = Join-Path $outDir "qingcode-agent-$arch"
        Copy-Item -Force $bin $dest
        Write-Host "== 已复制：$dest ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)"
    }

    Write-Host "完成。产物目录：$outDir"
}
finally {
    Pop-Location
}
