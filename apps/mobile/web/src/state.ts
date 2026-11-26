// 手机端状态纯逻辑：未知 JSON 的归一化、事件折叠、注释拼接。无 DOM / 网络依赖。
import { isValidHost, normalizeFingerprint, parsePort } from './link'
import type { Connection, Project, SshAuth, Target, TargetState, TargetStateEvent } from './types'

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const number = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const TARGET_STATES: readonly TargetState[] = ['idle', 'connecting', 'deploying', 'ready', 'error']

export const HOST_KEY_HINT = '请在电脑上确认主机指纹'

export type ThreadSummary = {
  id: string
  title: string
  preview: string
  cwd: string
  updatedAt: number
}

export type Annotation = { id: string; quote: string; comment: string }

export function toTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 1e12 ? value * 1000 : value
}

function parseAuth(value: unknown): SshAuth {
  const record = isRecord(value) ? value : null
  if (record?.kind === 'key') return { kind: 'key', keyPath: text(record.keyPath) }
  if (record?.kind === 'password') return { kind: 'password' }
  return { kind: 'agent' }
}

export function parseTargets(value: unknown): Target[] {
  const data = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : []
  const targets: Target[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const id = text(entry.id)
    if (!id) continue
    const name = text(entry.name) || id
    if (entry.kind === 'local' || id === 'local') {
      targets.push({ id: 'local', kind: 'local', name })
      continue
    }
    if (entry.kind !== 'ssh') continue
    targets.push({
      id,
      kind: 'ssh',
      name,
      host: text(entry.host),
      port: number(entry.port, 22),
      username: text(entry.username),
      auth: parseAuth(entry.auth),
    })
  }
  // targets.list 约定本机在首位；排序时不改变同类的相对顺序。
  return targets.sort((a, b) => (a.kind === 'local' ? -1 : b.kind === 'local' ? 1 : 0))
}

export function parseProjects(value: unknown): Project[] {
  const data = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.projects)
      ? value.projects
      : []
  const projects: Project[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const id = text(entry.id)
    const path = text(entry.path)
    if (!id || !path) continue
    projects.push({
      id,
      targetId: text(entry.targetId),
      name: text(entry.name) || path.split(/[\\/]/).filter(Boolean).pop() || path,
      path,
      lastOpenedAt: toTimestamp(entry.lastOpenedAt),
    })
  }
  return projects
}

export function projectsForTarget(projects: readonly Project[], targetId: string | null): Project[] {
  if (!targetId) return []
  return projects
    .filter((project) => project.targetId === targetId)
    .slice()
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

export function applyTargetState(
  states: Record<string, TargetStateEvent>,
  payload: unknown,
): Record<string, TargetStateEvent> {
  if (!isRecord(payload)) return states
  const id = text(payload.id)
  const state = text(payload.state)
  if (!id || !TARGET_STATES.includes(state as TargetState)) return states
  const detail = text(payload.detail)
  const event: TargetStateEvent = { id, state: state as TargetState, ...(detail ? { detail } : {}) }
  return { ...states, [id]: event }
}

export function targetStatus(states: Record<string, TargetStateEvent>, id: string): TargetState {
  return states[id]?.state ?? 'idle'
}

export function parseConnections(raw: string | null): Connection[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  const data = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.connections)
      ? parsed.connections
      : []
  const connections: Connection[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const id = text(entry.id)
    const token = text(entry.token)
    const fp = normalizeFingerprint(entry.fp)
    const host = text(entry.host)
    const port = parsePort(entry.port)
    if (!id || !token || !fp || !isValidHost(host) || port === null) continue
    connections.push({
      id,
      name: text(entry.name) || host,
      host,
      port,
      fp,
      token,
      desktopName: text(entry.desktopName),
      createdAt: number(entry.createdAt, 0),
    })
  }
  return connections
}

export function serializeConnections(connections: readonly Connection[]): string {
  return JSON.stringify(connections)
}

export function makeId(): string {
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID()
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function friendlyError(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (isRecord(err)) {
    const message = text(err.message) || text(err.error)
    if (message) return message
  }
  return fallback
}

export function errorCode(err: unknown): string {
  if (!isRecord(err)) return ''
  return text(err.code)
}

/** 连接新 SSH 主机时手机端不能确认指纹，必须由电脑端处理。 */
export function isHostKeyError(err: unknown): boolean {
  const source = `${errorCode(err)} ${friendlyError(err, '')}`
  return /hostkey|host_key|known_hosts|knownhosts|主机指纹|主机密钥|指纹变化|请在电脑上确认/i.test(source)
}

export function hostKeyMessage(err: unknown, fallback = '连接失败'): string {
  return isHostKeyError(err) ? HOST_KEY_HINT : friendlyError(err, fallback)
}

export function toThreadSummaries(value: unknown): ThreadSummary[] {
  const data = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data)
      ? value.data
      : []
  const summaries: ThreadSummary[] = []
  for (const entry of data) {
    if (!isRecord(entry)) continue
    const id = text(entry.id)
    if (!id) continue
    const preview = text(entry.preview)
    summaries.push({
      id,
      title: text(entry.name) || preview.split('\n')[0]?.trim() || '未命名会话',
      preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
      cwd: text(entry.cwd),
      updatedAt: toTimestamp(entry.updatedAt ?? entry.createdAt),
    })
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 目录浏览：Windows 与 POSIX 路径都要能回到上一级。 */
export function parentPath(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, '')
  if (!normalized) return null
  const slash = normalized.lastIndexOf('/')
  const backslash = normalized.lastIndexOf('\\')
  const index = Math.max(slash, backslash)
  if (index < 0) return null
  if (index === 0) return normalized.startsWith('/') ? '/' : null
  const parent = normalized.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent || null
}

export function joinPath(base: string, name: string): string {
  if (!base) return name
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** §12 的引用格式：多行逐行加 "> "，评论可空，注释块与正文之间空一行。 */
export function quoteText(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

export function formatQuotedMessage(annotations: readonly Annotation[], input: string): string {
  const body = input.trim()
  const blocks = annotations
    .map((annotation) => {
      const quote = quoteText(annotation.quote.trim())
      const comment = annotation.comment.trim()
      return comment ? `${quote}\n${comment}` : quote
    })
    .filter((block) => block.trim() !== '')
  return blocks.length === 0 ? body : `${blocks.join('\n\n')}\n\n${body}`
}
