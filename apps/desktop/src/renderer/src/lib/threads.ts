import { isActiveThread, sessionStatus, threadActivityFromStatus, type ThreadActivity, type ThreadView } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { DEFAULT_AGENT } from './agents'

const PREVIEW_LENGTH = 160

export type ThreadSummary = {
  id: string
  title: string
  preview: string
  cwd: string
  updatedAt: number
  agent: AgentKind
  activity?: ThreadActivity
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

// 旧会话可能以秒或毫秒给时间戳，统一成毫秒。
export function toTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 1e12 ? value * 1000 : value
}

export function toThreadSummaries(
  value: unknown,
  agent: AgentKind = DEFAULT_AGENT,
): ThreadSummary[] {
  const wrapper = isRecord(value) ? value : null
  const data = wrapper && Array.isArray(wrapper.data) ? wrapper.data : Array.isArray(value) ? value : []
  const summaries: ThreadSummary[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const id = text(entry.id)
    if (!id) continue
    const preview = text(entry.preview)
    const activity = threadActivityFromStatus(entry.status)
    summaries.push({
      id,
      title: text(entry.name) || preview.split('\n')[0]?.trim() || '未命名会话',
      preview: preview.length > PREVIEW_LENGTH ? `${preview.slice(0, PREVIEW_LENGTH)}…` : preview,
      cwd: text(entry.cwd),
      updatedAt: toTimestamp(entry.updatedAt ?? entry.recencyAt ?? entry.createdAt),
      agent,
      ...(activity ? { activity } : {}),
    })
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function threadPreviewText({ title, preview }: Pick<ThreadSummary, 'title' | 'preview'>): string {
  const excerpt = preview.trim()
  const [firstLine = '', ...remaining] = excerpt.split('\n')
  const heading = title.trim()
  // 未命名会话用摘要首行作标题，摘要也可能截在首行中间。
  if (firstLine.trim() === heading) return remaining.join('\n').trim()
  if (preview.length === PREVIEW_LENGTH + 1 && excerpt.endsWith('…') && heading.startsWith(excerpt.slice(0, -1))) {
    return ''
  }
  return excerpt
}

/** 两个 agent 的 id 各自独立，列表 key 必须带上 agent，避免 UUID 碰撞时错行。 */
export function threadKey(agent: AgentKind, id: string): string {
  return `${agent}:${id}`
}

export function isThreadInProgress(thread: ThreadSummary, view?: ThreadView): boolean {
  return isActiveThread(sessionStatus(view, thread.activity))
}

/** 临时将活动项提到前面，两组内部沿用当前顺序。 */
export function activeFirst<T>(items: readonly T[], isActive: (item: T) => boolean): T[] {
  const active: T[] = []
  const rest: T[] = []
  for (const item of items) {
    (isActive(item) ? active : rest).push(item)
  }
  return [...active, ...rest]
}

/** 合并 Codex / Claude 的会话，按更新时间降序；同时间时 Codex 在前保证顺序稳定。 */
export function mergeThreadSummaries(lists: readonly ThreadSummary[][]): ThreadSummary[] {
  return lists
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt || a.agent.localeCompare(b.agent))
}

// 项目列表刷新时保留已有行的位置，同时采用服务端最新的标题、时间和状态。
export function refreshThreadOrder(previous: ThreadSummary[], incoming: ThreadSummary[]): ThreadSummary[] {
  if (!previous.length) return incoming
  const remaining = new Map(incoming.map(thread => [threadKey(thread.agent, thread.id), thread]))
  const existing: ThreadSummary[] = []
  for (const thread of previous) {
    const key = threadKey(thread.agent, thread.id)
    const updated = remaining.get(key)
    if (updated) {
      existing.push(updated)
      remaining.delete(key)
    }
  }
  return [...remaining.values(), ...existing]
}

/**
 * 刚建的会话在首轮结束前，Agent 的 thread/list 可能还查不到（Codex 首轮落盘后才列出）。
 * 把本地记下的会话补进列表，cwd 为 null 的列表不限项目；服务端已返回的以服务端为准。
 */
export function withLocalThreads(incoming: ThreadSummary[], local: readonly ThreadSummary[], cwd: string | null): ThreadSummary[] {
  const known = new Set(incoming.map((thread) => threadKey(thread.agent, thread.id)))
  const missing = local.filter((thread) => !known.has(threadKey(thread.agent, thread.id)) && (cwd === null || thread.cwd === cwd))
  return missing.length ? mergeThreadSummaries([missing, incoming]) : incoming
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
