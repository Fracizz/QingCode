import type { AgentKind } from './types'

const AGENTS: readonly AgentKind[] = ['codex', 'claude', 'pi']
const isAgent = (value: unknown): value is AgentKind => AGENTS.includes(value as AgentKind)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type UnreadChange = { agent: AgentKind; threadId: string; unread: boolean }

export const unreadThreadKey = (agent: AgentKind, threadId: string) => `${agent}:${threadId}`

/** 解析目标机 thread.unread.list 的结果；格式不对返回 null（旧 daemon 不支持共享未读）。 */
export function unreadKeysFromList(result: unknown): Set<string> | null {
  if (!isRecord(result) || !Array.isArray(result.threads)) return null
  const keys = new Set<string>()
  for (const item of result.threads) {
    if (isRecord(item) && isAgent(item.agent) && typeof item.threadId === 'string' && item.threadId) {
      keys.add(unreadThreadKey(item.agent, item.threadId))
    }
  }
  return keys
}

/** 解析 server evt `thread.unread` 的负载。 */
export function parseUnreadChange(payload: unknown): UnreadChange | null {
  if (!isRecord(payload) || !isAgent(payload.agent) || typeof payload.threadId !== 'string' || !payload.threadId) return null
  if (typeof payload.unread !== 'boolean') return null
  return { agent: payload.agent, threadId: payload.threadId, unread: payload.unread }
}
