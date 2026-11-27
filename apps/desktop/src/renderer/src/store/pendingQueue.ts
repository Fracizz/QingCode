import type { UserInput } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'

/** 排队消息转到新会话的方式：空白会话开始，或继承已结束轮次的上下文继续。 */
export type PendingThreadMode = 'start' | 'continue'

// 引导走 turn/steer、继续走 thread/fork，目前只有 Codex 提供这两个 RPC。
export const canSteerQueued = (agent: AgentKind) => agent === 'codex'
export const canContinueQueued = (agent: AgentKind) => agent === 'codex'

/**
 * 把排队消息的正文换成新文本，附件、图片和技能保持不变。
 * 返回 null 表示改完后没有任何可发送内容。
 */
export function replacePendingText(input: readonly UserInput[], oldText: string, newText: string): UserInput[] | null {
  const next: UserInput[] = []
  let replaced = false
  for (const entry of input) {
    // 只替换与原正文一致的文本段，避免改动委派等额外拼进来的说明。
    if (!replaced && entry.type === 'text' && entry.text === oldText) {
      replaced = true
      if (newText.trim()) next.push({ ...entry, text: newText })
      continue
    }
    next.push(entry)
  }
  if (!replaced && newText.trim()) {
    // 原来没有正文（只有附件）时，正文放在技能之后，与 buildUserInput 的顺序一致。
    const at = next.findIndex((entry) => entry.type !== 'skill')
    next.splice(at < 0 ? next.length : at, 0, { type: 'text', text: newText, text_elements: [] })
  }
  return next.length ? next : null
}
