import type { AgentKind } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { threadKey } from '../lib/threads'
import { useThreadPrefs } from './threadPrefs'

const AGENTS: readonly AgentKind[] = ['codex', 'claude', 'pi']
const isAgent = (value: unknown): value is AgentKind => AGENTS.includes(value as AgentKind)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type UnreadChange = { agent: AgentKind; threadId: string; unread: boolean }

/** 解析 server 的 thread.unread.list 结果为本地偏好使用的会话键；格式不对返回 null（旧 daemon）。 */
export function unreadKeysFromList(result: unknown): string[] | null {
  if (!isRecord(result) || !Array.isArray(result.threads)) return null
  const keys: string[] = []
  for (const item of result.threads) {
    if (isRecord(item) && isAgent(item.agent) && typeof item.threadId === 'string' && item.threadId) {
      keys.push(threadKey(item.agent, item.threadId))
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

/**
 * 未读状态以目标机 daemon 为准，电脑和手机共用：本地先改，再回写目标机。
 * 旧版 daemon 没有该方法时只在本机生效。
 */
export function markThreadUnread(targetId: string, agent: AgentKind, threadId: string, unread: boolean): void {
  useThreadPrefs.getState().setUnread(targetId, threadKey(agent, threadId), unread)
  void Promise.resolve()
    .then(() => call('server.req', { targetId, method: 'thread.unread.set', params: { agent, threadId, unread } }))
    .catch(() => undefined)
}

/**
 * 连接目标后拉取目标机的未读列表并替换本地记录。
 * `viewing` 判断会话是否正在界面上，是则直接回写已读而不是显示未读。
 */
export async function pullThreadUnread(targetId: string, viewing: (agent: AgentKind, threadId: string) => boolean): Promise<void> {
  let keys: string[] | null
  try {
    keys = unreadKeysFromList(await call('server.req', { targetId, method: 'thread.unread.list', params: {} }))
  } catch {
    return
  }
  if (!keys) return
  const remaining = keys.filter((key) => {
    const index = key.indexOf(':')
    const agent = key.slice(0, index) as AgentKind
    const threadId = key.slice(index + 1)
    if (!viewing(agent, threadId)) return true
    markThreadUnread(targetId, agent, threadId, false)
    return false
  })
  useThreadPrefs.getState().replaceUnread(targetId, remaining)
}
