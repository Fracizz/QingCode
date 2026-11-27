#!/usr/bin/env bash
# 用 pi（hy4 / high）执行一张任务卡：bash scripts/pi-task.sh T1-protocol [追加说明]
# 日志：.dev/pi/<卡>.log；会话 id 固定为 qn-<卡>，可用 `pi --session-id qn-<卡>` 继续追问。
set -uo pipefail
export PATH="/c/Users/Administrator/AppData/Roaming/npm:/c/Program Files/nodejs:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARD="$1"; shift || true
EXTRA="${*:-}"
cd "$ROOT"
mkdir -p .dev/pi
"${PI_BIN:-pi}" -p -a --model opencode-go-zen/hy4 --thinking high --session-id "qn-$CARD" \
  "@AGENTS.md" "@docs/mvp.md" "@docs/tasks/$CARD.md" \
  "你是 QingCode Next 的开发 Agent。执行上面的任务卡 docs/tasks/$CARD.md，严格遵守 AGENTS.md（只改范围内文件、不装依赖、不提交）。完成后按 AGENTS.md 的完成标准自检，并输出最终报告。$EXTRA" \
  > ".dev/pi/$CARD.log" 2>&1
code=$?
echo "[pi-task] $CARD exit=$code" >> ".dev/pi/$CARD.log"
exit $code
