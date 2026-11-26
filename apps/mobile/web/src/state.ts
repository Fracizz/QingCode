// 手机端状态纯逻辑：未知 JSON 的归一化、事件折叠、注释拼接。无 DOM / 网络依赖。
import { approvalResponse, type ApprovalDecision, type ApprovalView, type UserInput } from '@qn/codex-client'
import { isValidHost, normalizeFingerprint, parsePort } from './link'
import type { AgentKind, Connection, Project, SshAuth, Target, TargetState, TargetStateEvent } from './types'

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
  activity?: 'pending' | 'running'
  /** 会话所属 Agent；打开会话时必须用它对应的会话通道。 */
  agent: AgentKind
}

export type Annotation = { id: string; quote: string; comment: string }
export type ChatDraft = { text: string; annotations: Annotation[] }
export type SavedChat = { targetId: string; projectId: string; agent: AgentKind; threadId: string }
export type RepairReason = 'fingerprint' | 'unauthorized'
export type MobileApprovalDecision = ApprovalDecision | 'cancel'

export function draftKey(
  desktopId: string, targetId: string, projectId: string | null, agent: AgentKind, threadId: string | null,
  fingerprint: string | null = null,
): string {
  return JSON.stringify([desktopId, targetId, projectId, agent, threadId, fingerprint])
}

export function parseStoredRecord(raw: string | null): JsonRecord {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

export function parseDrafts(raw: string | null): Record<string, ChatDraft> {
  const drafts: Record<string, ChatDraft> = Object.create(null)
  for (const [key, value] of Object.entries(parseStoredRecord(raw))) {
    if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.annotations)) continue
    const annotations = value.annotations.filter((item): item is Annotation => isRecord(item)
      && typeof item.id === 'string' && typeof item.quote === 'string' && typeof item.comment === 'string')
    drafts[key] = { text: value.text, annotations }
  }
  return drafts
}

export function parseSavedChats(raw: string | null): Record<string, SavedChat> {
  const chats: Record<string, SavedChat> = Object.create(null)
  for (const [key, entry] of Object.entries(parseStoredRecord(raw))) {
    if (!isRecord(entry)) continue
    const { targetId, projectId, threadId, agent } = entry
    if (typeof targetId !== 'string' || !targetId || typeof projectId !== 'string' || !projectId
      || typeof threadId !== 'string' || !threadId || (agent !== 'codex' && agent !== 'claude' && agent !== 'pi')) continue
    chats[key] = { targetId, projectId, threadId, agent }
  }
  return chats
}

export function connectionRepairReason(err: unknown): RepairReason | null {
  const code = errorCode(err)
  const message = friendlyError(err, '')
  if (code === 'fingerprint' || /地址指向了另一台电脑|证书指纹不匹配/.test(message)) return 'fingerprint'
  if (code === 'unauthorized' || /设备未配对|令牌已失效|设备已被撤销/.test(message)) return 'unauthorized'
  return null
}

export function availableApprovalDecisions(approval: ApprovalView, agent: AgentKind): MobileApprovalDecision[] {
  if (agent === 'pi') return []
  const raw = isRecord(approval.raw) ? approval.raw : null
  const params = isRecord(raw?.params) ? raw.params : null
  const supplied = params?.availableDecisions
  const withSession: MobileApprovalDecision[] = ['accept', 'acceptForSession', 'decline']
  let decisions: MobileApprovalDecision[]
  switch (approval.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'execCommandApproval':
    case 'applyPatchApproval':
      decisions = [...withSession, 'cancel']
      break
    case 'item/permissions/requestApproval':
      decisions = withSession
      break
    default:
      return []
  }
  const available = Array.isArray(supplied) ? decisions.filter((item) => supplied.includes(item)) : decisions
  return available.some((item) => item === 'decline' || item === 'cancel') ? available : []
}

export function mobileApprovalReply(approval: ApprovalView, decision: MobileApprovalDecision): unknown {
  if (decision !== 'cancel') return approvalResponse(approval, decision)
  const legacy = approval.method === 'execCommandApproval' || approval.method === 'applyPatchApproval'
  return { decision: legacy ? 'abort' : 'cancel' }
}

export function buildMobileTurnInput(agent: AgentKind, text: string, attachments: readonly UserInput[]): UserInput[] {
  const extras: UserInput[] = []
  const fileLines: string[] = []
  for (const item of attachments) {
    if (agent === 'codex' && item.type === 'mention' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(item.path)) {
      fileLines.push(`- ${item.name || item.path}: ${item.path}`)
    } else {
      extras.push(item)
    }
  }
  const body = fileLines.length
    ? [text, ['附件文件（请按需读取）：', ...fileLines].join('\n')].filter(Boolean).join('\n\n')
    : text
  return body ? [{ type: 'text', text: body, text_elements: [] }, ...extras] : extras
}

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

export function toThreadSummaries(value: unknown, agent: AgentKind = 'codex'): ThreadSummary[] {
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
    const status = isRecord(entry.status) ? entry.status : null
    const activity = status?.type === 'active'
      ? Array.isArray(status.activeFlags) && status.activeFlags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
        ? 'pending'
        : 'running'
      : undefined
    summaries.push({
      id,
      title: text(entry.name) || preview.split('\n')[0]?.trim() || '未命名会话',
      preview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview,
      cwd: text(entry.cwd),
      updatedAt: toTimestamp(entry.updatedAt ?? entry.recencyAt ?? entry.createdAt),
      agent,
      ...(activity ? { activity } : {}),
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
