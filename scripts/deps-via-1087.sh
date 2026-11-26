#!/usr/bin/env bash
# 依赖安装经 10.87（agent-cli-x peer windows-91295）中转：本机直连 npm/GitHub 不稳定。
# 流程：把各 package.json + 锁文件推到 10.87 → 在那里 pnpm install（本次专用 store）→
# 打包 store 与锁文件取回 → 本机 --offline 安装；Electron 二进制同样在 10.87 下载后取回。
# 结束后删除 10.87 上的全部临时文件（"剪切"到本机）。
# 用法：bash scripts/deps-via-1087.sh            （新增/修改依赖后重跑即可）
set -euo pipefail

PEER=windows-91295
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/.deps-stage"
STORE="${QN_PNPM_STORE:-/d/code/.qn-pnpm-store}"   # 本机离线 store，放仓库外复用
RUN="qn-deps-$(date +%Y%m%d%H%M%S)"                # 10.87 上本次专用目录（dl: 下）

cd "$ROOT"
ELECTRON_VERSION=$(node -p "require('./apps/desktop/package.json').devDependencies.electron")

rm -rf "$STAGE" && mkdir -p "$STAGE/manifest"
for f in package.json pnpm-workspace.yaml pnpm-lock.yaml packages/*/package.json apps/*/package.json; do
  [ -f "$f" ] || continue
  mkdir -p "$STAGE/manifest/$(dirname "$f")"
  cp "$f" "$STAGE/manifest/$f"
done

cleanup_remote() {
  agent-cli-x exec "$PEER" --cwd dl: --timeout 120 "Remove-Item -Recurse -Force '$RUN' -ErrorAction SilentlyContinue; exit 0" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

echo "[1/5] 推送清单到 10.87（dl:$RUN）"
agent-cli-x put "$PEER" "$STAGE/manifest" "dl:$RUN/manifest" >/dev/null

echo "[2/5] 10.87 上 pnpm install + 下载 Electron $ELECTRON_VERSION"
# 用 detach + follow：同步 exec 的输出要等结束才可见，卡住时无法判断。
JOB_OUT=$(agent-cli-x exec "$PEER" --cwd "dl:$RUN" --detach --timeout 2400 "
\$ErrorActionPreference = 'Stop'
\$env:CI = '1'
\$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
\$store = Join-Path (Get-Location) 'store'
\$cache = Join-Path (Get-Location) 'cache'
Set-Location manifest
\$ok = \$false
foreach (\$i in 1..3) {
  pnpm install --no-frozen-lockfile --store-dir \$store --cache-dir \$cache --ignore-scripts --reporter=append-only --config.confirmModulesPurge=false --config.fetch-retries=6 2>&1
  if (\$LASTEXITCODE -eq 0) { \$ok = \$true; break }
  'pnpm install 第' + \$i + '次失败，重试'
}
if (-not \$ok) { exit 1 }
Set-Location ..
\$zip = 'electron-v$ELECTRON_VERSION-win32-x64.zip'
Invoke-WebRequest \"https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/\$zip\" -OutFile \$zip -UseBasicParsing
tar -czf store.tgz store cache
Get-ChildItem store.tgz, \$zip | ForEach-Object { '{0} {1:N1}MB' -f \$_.Name, (\$_.Length/1MB) }
'QN_REMOTE_DONE'
" 2>&1)
JOB=$(printf '%s\n' "$JOB_OUT" | grep -oE 'job [0-9]{8}-[0-9]{6}-[0-9a-f]+' | head -1 | cut -d' ' -f2)
[ -n "$JOB" ] || { echo "启动远端任务失败：$JOB_OUT"; exit 1; }
LOG=$(agent-cli-x job logs "$PEER" "$JOB" --follow 2>&1 || true)
printf '%s\n' "$LOG" | grep -vE '^Progress:' | tail -8
printf '%s\n' "$LOG" | grep -q QN_REMOTE_DONE || { echo "10.87 安装失败（job $JOB）"; exit 1; }

echo "[3/5] 取回锁文件、store、Electron"
agent-cli-x get "$PEER" "dl:$RUN/manifest/pnpm-lock.yaml" "$ROOT/pnpm-lock.yaml" >/dev/null
agent-cli-x get "$PEER" "dl:$RUN/store.tgz" "$STAGE/store.tgz" >/dev/null
agent-cli-x get "$PEER" "dl:$RUN/electron-v$ELECTRON_VERSION-win32-x64.zip" "$STAGE/electron.zip" >/dev/null

echo "[4/5] 本机离线安装"
# store 放仓库外复用；元数据缓存（供应链策略校验要用）合并进本机默认 pnpm 缓存，避免 --offline 时仍联网
CACHE="$(cygpath -u "$LOCALAPPDATA")/pnpm-cache"
mkdir -p "$STORE" "$CACHE" "$STAGE/x"
tar --force-local -xzf "$STAGE/store.tgz" -C "$STAGE/x"
cp -rn "$STAGE/x/store/." "$STORE/" 2>/dev/null || true  # 内容寻址，已存在即相同；占用中的文件跳过
cp -r "$STAGE/x/cache/." "$CACHE/" 2>/dev/null || true
CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --offline --frozen-lockfile --store-dir "$(cygpath -w "$STORE")" --config.confirmModulesPurge=false

echo "[5/5] 解压 Electron 到 node_modules"
EDIR=$(cd "$ROOT/apps/desktop" && node -p "require('path').dirname(require.resolve('electron/package.json'))")
EDIR=$(cygpath -u "$EDIR")
rm -rf "$EDIR/dist" && mkdir -p "$EDIR/dist"
unzip -q "$STAGE/electron.zip" -d "$EDIR/dist"
printf 'electron.exe' > "$EDIR/path.txt"
# esbuild 等需要 postinstall 的包：离线重建
pnpm rebuild esbuild >/dev/null 2>&1 || true

rm -rf "$STAGE"
echo "完成：electron $("$EDIR/dist/electron.exe" --version 2>/dev/null || echo 已解压)"
