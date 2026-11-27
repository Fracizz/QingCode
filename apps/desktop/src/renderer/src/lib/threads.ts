import { threadActivityFromStatus, type ThreadActivity } from '@qn/codex-client'
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

/** 合并 Codex / Claude 的会话，按更新时间降序；同时间时 Codex 在前保证顺序稳定。 */
export function mergeThreadSummaries(lists: readonly ThreadSummary[][]): ThreadSummary[] {
  return lists
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt || a.agent.localeCompare(b.agent))
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
