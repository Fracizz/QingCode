#!/usr/bin/env bash
# 继续未成功结束的 pi 任务卡（额度中断后用）：bash scripts/pi-resume.sh [延迟秒] 卡1 卡2 ...
# 只重跑日志末行不是 exit=0 的卡；同一 session id 续上原会话上下文。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DELAY="${1:-0}"; shift || true
sleep "$DELAY"
cd "$ROOT"
pids=()
for card in "$@"; do
  if tail -n 1 ".dev/pi/$card.log" 2>/dev/null | grep -q 'exit=0'; then continue; fi
  cp ".dev/pi/$card.log" ".dev/pi/$card.prev.log" 2>/dev/null || true
  bash scripts/pi-task.sh "$card" "上一轮因模型额度中断，工作区里已有你写的部分代码：先 git status / 阅读本卡范围内现有文件，对照任务卡逐条核对缺什么，补齐后自检并输出最终报告。同时阅读 docs/roadmap.md。" &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done
for card in "$@"; do echo "$card: $(tail -n 1 .dev/pi/$card.log)"; done
