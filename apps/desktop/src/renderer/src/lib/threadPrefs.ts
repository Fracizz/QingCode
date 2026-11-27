import type { ThreadSummary } from './threads'
import { threadKey } from './threads'

/**
 * 会话的本地偏好（只存在本机，不回写 agent）：
 * - pinned：置顶，值为置顶时间，越晚置顶越靠前
 * - unread：手动标记为未读，打开会话即清除
 * - names：agent 不支持 thread/name/set 时（如 Claude）的本地重命名
 * - hidden：agent 不支持 thread/archive 时的本地归档
 * 键统一用 threadKey(agent, id)，并按目标隔离，避免不同主机的同 id 会话互相影响。
 */
export type ThreadPrefs = {
  pinned: Record<string, number>
  unread: Record<string, true>
  names: Record<string, string>
  hidden: Record<string, true>
}

export const emptyThreadPrefs = (): ThreadPrefs => ({ pinned: {}, unread: {}, names: {}, hidden: {} })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function pick<T>(value: unknown, accept: (entry: unknown) => entry is T): Record<string, T> {
  const result: Record<string, T> = {}
  if (!isRecord(value)) return result
  for (const [key, entry] of Object.entries(value)) {
    if (accept(entry)) result[key] = entry
  }
  return result
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isTrue = (value: unknown): value is true => value === true
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function parseThreadPrefs(raw: string | null): Record<string, ThreadPrefs> {
  if (!raw) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(data)) return {}
  const result: Record<string, ThreadPrefs> = {}
  for (const [targetId, value] of Object.entries(data)) {
    if (!isRecord(value)) continue
    result[targetId] = {
      pinned: pick(value.pinned, isNumber),
      unread: pick(value.unread, isTrue),
      names: pick(value.names, isName),
      hidden: pick(value.hidden, isTrue),
    }
  }
  return result
}

/** 应用本地偏好：过滤本地归档、套用本地名称，置顶的排在最前（按置顶时间倒序），其余保持原顺序。 */
export function applyThreadPrefs(threads: readonly ThreadSummary[], prefs: ThreadPrefs | undefined): ThreadSummary[] {
  if (!prefs) return [...threads]
  const visible = threads
    .filter((thread) => !prefs.hidden[threadKey(thread.agent, thread.id)])
    .map((thread) => {
      const name = prefs.names[threadKey(thread.agent, thread.id)]
      return name ? { ...thread, title: name } : thread
    })
  const pinned = visible
    .filter((thread) => prefs.pinned[threadKey(thread.agent, thread.id)] !== undefined)
    .sort(
      (a, b) =>
        (prefs.pinned[threadKey(b.agent, b.id)] ?? 0) - (prefs.pinned[threadKey(a.agent, a.id)] ?? 0),
    )
  const rest = visible.filter((thread) => prefs.pinned[threadKey(thread.agent, thread.id)] === undefined)
  return [...pinned, ...rest]
}

/** 不可变地切换某个集合里的键。 */
export function toggleKey<T>(map: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  const next = { ...map }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}
