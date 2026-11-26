#!/usr/bin/env bash
# Android 构建工具链经 10.87 中转：JDK 17（Microsoft OpenJDK）+ Android SDK（platforms;android-35、build-tools;35.0.0）。
# 在 87 下载/安装后打包取回，解压到本机 $QN_TOOLCHAIN（默认 D:\code\.qn-toolchain），然后删除 87 上的临时文件。
# 用法：bash scripts/android-toolchain-via-1087.sh
set -euo pipefail

PEER=windows-91295
DEST="${QN_TOOLCHAIN:-/d/code/.qn-toolchain}"
RUN="qn-android-$(date +%Y%m%d%H%M%S)"
STAGE="$(mktemp -d)"

cleanup() {
  agent-cli-x exec "$PEER" --cwd dl: --timeout 300 "Remove-Item -Recurse -Force '$RUN' -ErrorAction SilentlyContinue; exit 0" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

agent-cli-x exec "$PEER" --cwd dl: --timeout 60 "New-Item -ItemType Directory '$RUN' | Out-Null" >/dev/null

echo "[1/3] 10.87 下载 JDK 17 与 Android SDK（会接受 Android SDK 许可）"
JOB_OUT=$(agent-cli-x exec "$PEER" --cwd "dl:$RUN" --detach --timeout 3600 "
\$ErrorActionPreference = 'Stop'
\$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest 'https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip' -OutFile jdk.zip -UseBasicParsing
Expand-Archive jdk.zip -DestinationPath jdk-tmp
\$jdkDir = Get-ChildItem jdk-tmp -Directory | Select-Object -First 1
Move-Item \$jdkDir.FullName jdk
Remove-Item -Recurse jdk-tmp, jdk.zip
Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip' -OutFile clt.zip -UseBasicParsing
New-Item -ItemType Directory sdk/cmdline-tools | Out-Null
Expand-Archive clt.zip -DestinationPath sdk/cmdline-tools
Rename-Item sdk/cmdline-tools/cmdline-tools latest
Remove-Item clt.zip
\$env:JAVA_HOME = (Resolve-Path jdk).Path
\$sm = (Resolve-Path sdk/cmdline-tools/latest/bin/sdkmanager.bat).Path
\$sdkRoot = (Resolve-Path sdk).Path
# PowerShell 管道喂不进 .bat 的 stdin，许可确认改用 cmd 重定向
Set-Content -Path yes.txt -Value ((1..40 | ForEach-Object { 'y' }) -join \"\`r\`n\") -Encoding ascii
cmd /c \"\`\"\$sm\`\" --sdk_root=\`\"\$sdkRoot\`\" --licenses < yes.txt\" | Out-Null
cmd /c \"\`\"\$sm\`\" --sdk_root=\`\"\$sdkRoot\`\" platforms;android-35 build-tools;35.0.0 < yes.txt\" | Select-String -NotMatch '\[=' | Select-Object -Last 3
if (-not (Test-Path (Join-Path \$sdkRoot 'build-tools/35.0.0'))) { exit 1 }
Remove-Item -Recurse -Force (Join-Path \$sdkRoot '.temp') -ErrorAction SilentlyContinue
tar -czf toolchain.tgz jdk sdk
'{0:N1}MB' -f ((Get-Item toolchain.tgz).Length/1MB)
'QN_REMOTE_DONE'
" 2>&1)
JOB=$(printf '%s\n' "$JOB_OUT" | grep -oE 'job [0-9]{8}-[0-9]{6}-[0-9a-f]+' | head -1 | cut -d' ' -f2)
[ -n "$JOB" ] || { echo "启动远端任务失败：$JOB_OUT"; exit 1; }
LOG=$(agent-cli-x job logs "$PEER" "$JOB" --follow 2>&1 || true)
printf '%s\n' "$LOG" | tail -6
printf '%s\n' "$LOG" | grep -q QN_REMOTE_DONE || { echo "10.87 下载失败（job $JOB）"; exit 1; }

echo "[2/3] 取回"
agent-cli-x get "$PEER" "dl:$RUN/toolchain.tgz" "$STAGE/toolchain.tgz" >/dev/null

echo "[3/3] 解压到 $DEST"
mkdir -p "$DEST"
rm -rf "$DEST/jdk" "$DEST/android-sdk"
tar --force-local -xzf "$STAGE/toolchain.tgz" -C "$DEST"
mv "$DEST/sdk" "$DEST/android-sdk"
"$DEST/jdk/bin/javac.exe" -version
ls "$DEST/android-sdk/build-tools" "$DEST/android-sdk/platforms"
echo "完成。构建时设置：JAVA_HOME=$(cygpath -w "$DEST/jdk") ANDROID_HOME=$(cygpath -w "$DEST/android-sdk")"
