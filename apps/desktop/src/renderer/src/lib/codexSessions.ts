import type { AgentKind } from '../../../shared/backendApi'
import { parseSessionKey } from './agents'

// 额度 store 只需要 rpc 与 opened，用结构读取避免绑定 codex store 的内部类型。
export type RpcLike = {
  request(method: string, params?: unknown): Promise<unknown>
  onNotification(cb: (notification: unknown) => void): () => void
}

export type SessionLike = { rpc: RpcLike; opened: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function asSession(value: unknown): SessionLike | null {
  if (!isRecord(value)) return null
  const rpc = value.rpc
  if (
    !isRecord(rpc) ||
    typeof rpc.request !== 'function' ||
    typeof rpc.onNotification !== 'function'
  ) {
    return null
  }
  return { rpc: rpc as unknown as RpcLike, opened: value.opened === true }
}

/** 从「agent:目标」会话键还原额度条目的归属；旧键缺省视为 codex。 */
export function sessionScope(key: string): { targetId: string; agent: AgentKind } {
  return parseSessionKey(key)
}

export function sessionsOf(state: unknown): Record<string, SessionLike> {
  const sessions = isRecord(state) ? state.sessions : null
  if (!isRecord(sessions)) return {}
  const result: Record<string, SessionLike> = {}
  for (const [targetId, value] of Object.entries(sessions)) {
    const session = asSession(value)
    if (session) result[targetId] = session
  }
  return result
}
