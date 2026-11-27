#!/usr/bin/env bash
# 在 93 上跑原型；只在 /tmp/qn-spike-<随机> 下落地文件，退出时整目录删除。
# 用法：bash run-remote.sh measure | bash run-remote.sh demo
set -euo pipefail

HOST="${QN_SPIKE_HOST:-root@192.168.10.93}"
MODE="${1:-measure}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FILES=(
  control.mjs
  probe.mjs
  pythonBridge.mjs
  pty.mjs
  termBuffer.mjs
  demo.mjs
  measure.mjs
  smoke.mjs
  debug.mjs
)

REMOTE_DIR="$(ssh -o BatchMode=yes "$HOST" 'mktemp -d /tmp/qn-spike-XXXXXXXX')"
cleanup() {
  ssh -o BatchMode=yes "$HOST" "rm -rf '$REMOTE_DIR'" >/dev/null 2>&1 || true
}
# timeout / Ctrl+C 也要删掉远端临时目录，否则会在 93 上留垃圾。
trap cleanup EXIT INT TERM HUP

# 用 tar 走 ssh stdin，避免 Windows/MSYS 路径转换问题；不安装任何软件。
tar -cf - -C "$HERE" "${FILES[@]}" | ssh -o BatchMode=yes "$HOST" "tar -xf - -C '$REMOTE_DIR'"

case "$MODE" in
  measure)
    mkdir -p "$HERE/results"
    FILTER_ENV=""
    if [[ -n "${QN_SPIKE_ONLY:-}" ]]; then
      FILTER_ENV="QN_SPIKE_ONLY='${QN_SPIKE_ONLY}'"
    fi
    ssh -o BatchMode=yes "$HOST" \
      "cd '$REMOTE_DIR' && QN_SPIKE_DIR='$REMOTE_DIR' $FILTER_ENV node measure.mjs > '$REMOTE_DIR/report.json'" \
      2>&1 | tee "$HERE/results/93-measure.log"
    ssh -o BatchMode=yes "$HOST" "cat '$REMOTE_DIR/report.json'" > "$HERE/results/93-measurements.json"
    echo "结果: $HERE/results/93-measurements.json；诊断: $HERE/results/93-measure.log"
    ;;
  demo)
    ssh -t -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && node demo.mjs"
    ;;
  smoke)
    ssh -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && node smoke.mjs ${2:-python}"
    ;;
  debug)
    ssh -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && node debug.mjs ${2:-python}"
    ;;
  demo-auto)
    # 非交互验收：强制分配远端 pty，喂两行命令看 demo.mjs 是否转发。
    printf 'printf "QN_DEMO_%%s\\n" "$((40+2))"\nexit\n' | \
      ssh -tt -o BatchMode=yes "$HOST" "cd '$REMOTE_DIR' && node demo.mjs"
    ;;
  *)
    echo "用法: bash run-remote.sh measure | demo" >&2
    exit 2
    ;;
esac
