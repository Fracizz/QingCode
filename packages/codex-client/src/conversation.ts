import type {
  AdditionalFileSystemPermissions,
  AdditionalNetworkPermissions,
  ApplyPatchApprovalResponse,
  CommandExecutionRequestApprovalResponse,
  ExecCommandApprovalResponse,
  FileChangeRequestApprovalResponse,
  GrantedPermissionProfile,
  PermissionsRequestApprovalResponse,
  RequestId,
  ReviewDecision,
  ServerNotification,
  ServerRequest,
  Thread,
} from './codex-types'

export type ConversationState = { threads: Record<string, ThreadView> }

export type ThreadView = {
  id: string
  status: 'idle' | 'running' | 'error'
  activeTurnId: string | null
  items: ItemView[]
  pendingApprovals: ApprovalView[]
  error?: string
  tokenUsage?: unknown
}

export type ItemView =
  | {
      kind: 'user'
      id: string
      text: string
      /** 图片：data URL / http URL（可直接显示），或目标机上的本地图片路径（只显示文件名）。 */
      images?: string[]
      /** 用户附加的文件（目标机绝对路径）。 */
      files?: string[]
      /** 触发的技能名。 */
      skills?: string[]
    }
  | { kind: 'agent'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; summary: string; streaming: boolean }
  | { kind: 'command'; id: string; command: string; cwd?: string; output: string; exitCode?: number | null; status: string }
  | { kind: 'fileChange'; id: string; changes: { path: string; kind: string; diff?: string }[]; status: string }
  | { kind: 'other'; id: string; type: string; summary: string }

export type ApprovalView = {
  requestId: RequestId
  threadId: string
  itemId?: string
  kind: 'command' | 'fileChange' | 'permissions' | 'other'
  title: string
  detail: string
  method: string
  raw: unknown
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline'
export type LoadableThread = Thread | { thread: Thread }

type ThreadStatus = ThreadView['status']
type JsonRecord = Record<string, unknown>
type FileChangeItem = Extract<ItemView, { kind: 'fileChange' }>
type FileChange = FileChangeItem['changes'][number]

const SUMMARY_SEPARATOR = '\n\n'
const PATCH_OUTPUT_PATH = '(patch output)'
const PATCH_OUTPUT_KIND = 'output'

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function idValue(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function asRequestId(value: unknown): RequestId | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

function indexValue(value: unknown, fallback = 0): number {
  const candidate = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : fallback
}

function optionalNumber(value: unknown): number | null | undefined {
  return typeof value === 'number' ? value : value === null ? null : undefined
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function ownThread(s: ConversationState, id: string): ThreadView | undefined {
  return Object.hasOwn(s.threads, id) ? s.threads[id] : undefined
}

function emptyThread(id: string): ThreadView {
  return { id, status: 'idle', activeTurnId: null, items: [], pendingApprovals: [] }
}

export function emptyState(): ConversationState {
  return { threads: {} }
}

function withThread(
  s: ConversationState,
  id: string,
  update: (thread: ThreadView) => ThreadView,
): ConversationState {
  if (!id) return s
  const current = ownThread(s, id) ?? emptyThread(id)
  const updated = update(current)
  if (updated === current) return s
  return { threads: { ...s.threads, [id]: updated } }
}

function clearError(thread: ThreadView): ThreadView {
  const next = { ...thread }
  delete next.error
  return next
}

function statusFromValue(value: unknown): ThreadStatus {
  const type = asRecord(value)?.type ?? value
  if (type === 'active') return 'running'
  if (type === 'systemError') return 'error'
  return 'idle'
}

function withStatus(s: ConversationState, id: string, status: ThreadStatus): ConversationState {
  return withThread(s, id, (thread) => {
    const next: ThreadView = {
      ...thread,
      status,
      activeTurnId: status === 'idle' ? null : thread.activeTurnId,
    }
    if (status !== 'error') delete next.error
    return next
  })
}

function threadIdFrom(params: JsonRecord): string {
  const nested = asRecord(params.thread)
  return (
    idValue(params.threadId) ||
    idValue(nested?.id) ||
    idValue(params.conversationId) ||
    idValue(params.sessionId)
  )
}

function turnIdFrom(params: JsonRecord): string {
  const nested = asRecord(params.turn)
  return idValue(params.turnId) || idValue(nested?.id)
}

function itemIdFrom(params: JsonRecord): string {
  const item = asRecord(params.item)
  return (
    idValue(params.itemId) ||
    idValue(item?.id) ||
    idValue(params.callId) ||
    idValue(params.approvalId)
  )
}

function replaceItem(
  items: ItemView[],
  id: string,
  create: () => ItemView,
  update: (item: ItemView) => ItemView,
): ItemView[] {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return [...items, create()]
  const existing = items[index]
  if (!existing) return [...items, create()]
  const updated = update(existing)
  if (updated === existing) return items
  const next = items.slice()
  next[index] = updated
  return next
}

function withItem(
  s: ConversationState,
  params: JsonRecord,
  create: (id: string) => ItemView,
  update: (item: ItemView) => ItemView,
  markRunning: boolean,
): ConversationState {
  const threadId = threadIdFrom(params)
  const itemId = itemIdFrom(params)
  if (!threadId || !itemId) return s
  const turnId = turnIdFrom(params)

  return withThread(s, threadId, (thread) => {
    const next: ThreadView = {
      ...thread,
      items: replaceItem(thread.items, itemId, () => create(itemId), update),
      status: markRunning ? 'running' : thread.status,
      activeTurnId: turnId || thread.activeTurnId,
    }
    if (markRunning) delete next.error
    return next
  })
}

/** userMessage.content 里的非文本项：图片、附加文件、技能。 */
function userExtras(value: unknown): { images?: string[]; files?: string[]; skills?: string[] } {
  const images: string[] = []
  const files: string[] = []
  const skills: string[] = []
  for (const entry of arrayOf(value)) {
    const record = asRecord(entry)
    if (!record) continue
    const type = scalarText(record.type)
    if (type === 'image') {
      const url = scalarText(record.url)
      if (url) images.push(url)
    } else if (type === 'localImage') {
      const path = scalarText(record.path)
      if (path) images.push(path)
    } else if (type === 'mention') {
      const path = scalarText(record.path)
      if (path) files.push(path)
    } else if (type === 'skill') {
      const name = scalarText(record.name)
      if (name) skills.push(name)
    }
  }
  return {
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(skills.length ? { skills } : {}),
  }
}

function userText(value: unknown): string {
  const parts: string[] = []
  for (const entry of arrayOf(value)) {
    const record = asRecord(entry)
    if (!record) continue
    const text = scalarText(record.text)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

function reasoningText(value: unknown): string {
  const parts: string[] = []
  for (const entry of arrayOf(value)) {
    const text = scalarText(entry)
    if (text) parts.push(text)
  }
  return parts.join(SUMMARY_SEPARATOR)
}

function changeKind(value: unknown): string {
  const record = asRecord(value)
  if (record) return scalarText(record.type) || 'unknown'
  return scalarText(value) || 'unknown'
}

function fileChanges(value: unknown): FileChange[] {
  return arrayOf(value).map((entry) => {
    const record = asRecord(entry)
    const change: FileChange = {
      path: scalarText(record?.path),
      kind: changeKind(record?.kind),
    }
    if (typeof record?.diff === 'string') change.diff = record.diff
    return change
  })
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(' ')
  return ''
}

function isOutputMarker(change: FileChange): boolean {
  return change.kind === PATCH_OUTPUT_KIND && change.path === PATCH_OUTPUT_PATH
}

function itemViewFromRaw(raw: unknown, index: number, streaming: boolean): ItemView {
  const item = asRecord(raw)
  if (!item) return { kind: 'other', id: `unknown-${index}`, type: 'unknown', summary: '' }

  const type = scalarText(item.type) || 'unknown'
  const id = idValue(item.id) || `${type}-${index}`
  const status = scalarText(item.status) || (streaming ? 'inProgress' : 'completed')

  switch (type) {
    case 'userMessage':
      return { kind: 'user', id, text: userText(item.content) || scalarText(item.text), ...userExtras(item.content) }
    case 'agentMessage':
      return { kind: 'agent', id, text: scalarText(item.text), streaming }
    case 'reasoning':
      return {
        kind: 'reasoning',
        id,
        summary: reasoningText(item.summary) || reasoningText(item.content),
        streaming,
      }
    case 'commandExecution': {
      const cwd = scalarText(item.cwd)
      const view: Extract<ItemView, { kind: 'command' }> = {
        kind: 'command',
        id,
        command: commandText(item.command),
        output: scalarText(item.aggregatedOutput) || scalarText(item.output),
        exitCode: optionalNumber(item.exitCode) ?? null,
        status,
      }
      if (cwd) view.cwd = cwd
      return view
    }
    case 'fileChange':
      return { kind: 'fileChange', id, changes: fileChanges(item.changes), status }
    default: {
      const summary =
        scalarText(item.text) ||
        scalarText(item.review) ||
        scalarText(item.prompt) ||
        scalarText(item.command) ||
        scalarText(item.tool) ||
        scalarText(item.name) ||
        safeStringify(item)
      return { kind: 'other', id, type, summary }
    }
  }
}

function longer(left: string, right: string): string {
  return right.length >= left.length ? right : left
}

function mergeFileChanges(existing: FileChange[], candidate: FileChange[]): FileChange[] {
  const outputMarkers = existing.filter(isOutputMarker)
  const merged = candidate.map((change) => {
    const previous = existing.find(
      (entry) => !isOutputMarker(entry) && entry.path === change.path && entry.kind === change.kind,
    )
    if (!previous || typeof previous.diff !== 'string') return change
    const currentDiff = change.diff ?? ''
    const diff = longer(previous.diff, currentDiff)
    return diff === currentDiff ? change : { ...change, diff }
  })
  const markers = candidate.some(isOutputMarker) ? [] : outputMarkers
  return candidate.length > 0 ? [...merged, ...markers] : existing
}

function mergeItemView(existing: ItemView, candidate: ItemView): ItemView {
  if (existing.id !== candidate.id) return candidate
  if (existing.kind === 'agent' && candidate.kind === 'agent') {
    return {
      ...existing,
      ...candidate,
      text: longer(existing.text, candidate.text),
    }
  }
  if (existing.kind === 'reasoning' && candidate.kind === 'reasoning') {
    return { ...candidate, summary: longer(existing.summary, candidate.summary) }
  }
  if (existing.kind === 'command' && candidate.kind === 'command') {
    const cwd = candidate.cwd ?? existing.cwd
    const merged: Extract<ItemView, { kind: 'command' }> = {
      ...candidate,
      command: candidate.command || existing.command,
      output: longer(existing.output, candidate.output),
      exitCode: candidate.exitCode ?? existing.exitCode,
      status: candidate.status || existing.status,
    }
    if (cwd) merged.cwd = cwd
    return merged
  }
  if (existing.kind === 'fileChange' && candidate.kind === 'fileChange') {
    return {
      ...candidate,
      changes: mergeFileChanges(existing.changes, candidate.changes),
      status: candidate.status || existing.status,
    }
  }
  if (existing.kind === 'user' && candidate.kind === 'user') {
    return { ...candidate, text: longer(existing.text, candidate.text) }
  }
  if (existing.kind === 'other' && candidate.kind === 'other') {
    return { ...candidate, summary: longer(existing.summary, candidate.summary) }
  }
  return candidate
}

function mergeTurnItems(thread: ThreadView, turn: unknown, streaming: boolean): ThreadView {
  const record = asRecord(turn)
  if (!record || !Array.isArray(record.items)) return thread
  let items = thread.items
  for (let index = 0; index < record.items.length; index++) {
    const candidate = itemViewFromRaw(record.items[index], index, streaming)
    items = replaceItem(items, candidate.id, () => candidate, (existing) => mergeItemView(existing, candidate))
  }
  return { ...thread, items }
}

function finalizeItems(thread: ThreadView): ThreadView {
  return {
    ...thread,
    items: thread.items.map((item) =>
      item.kind === 'agent' || item.kind === 'reasoning' ? { ...item, streaming: false } : item,
    ),
  }
}

function summaryParts(summary: string, index: number): string[] {
  const parts = summary.length > 0 ? summary.split(SUMMARY_SEPARATOR) : []
  while (parts.length <= index) parts.push('')
  return parts
}

function appendSummaryText(summary: string, index: number, delta: string): string {
  const parts = summaryParts(summary, index)
  parts[index] = (parts[index] ?? '') + delta
  return parts.join(SUMMARY_SEPARATOR)
}

function addSummaryPart(summary: string, index: number): string {
  return summaryParts(summary, index).join(SUMMARY_SEPARATOR)
}

function appendFileChangeOutput(existing: ItemView, delta: string): ItemView {
  if (existing.kind !== 'fileChange') {
    return {
      kind: 'fileChange',
      id: existing.id,
      changes: [{ path: PATCH_OUTPUT_PATH, kind: PATCH_OUTPUT_KIND, diff: delta }],
      status: 'inProgress',
    }
  }
  const changes = existing.changes.slice()
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]
    if (change && !isOutputMarker(change)) {
      changes[index] = { ...change, diff: `${change.diff ?? ''}${delta}` }
      break
    }
  }
  const last = changes[changes.length - 1]
  if (last && isOutputMarker(last)) {
    changes[changes.length - 1] = { ...last, diff: `${last.diff ?? ''}${delta}` }
  } else {
    changes.push({ path: PATCH_OUTPUT_PATH, kind: PATCH_OUTPUT_KIND, diff: delta })
  }
  return { ...existing, changes }
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  const record = asRecord(value)
  if (!record) return undefined
  return scalarText(record.message) || undefined
}

export function loadThread(s: ConversationState, thread: LoadableThread): ConversationState {
  const wrapper = asRecord(thread as unknown)
  const raw = (wrapper && asRecord(wrapper.thread)) ?? wrapper
  if (!raw) return s
  const id = idValue(raw.id)
  if (!id) return s

  const previous = ownThread(s, id)
  let status = statusFromValue(raw.status)
  let activeTurnId: string | null = status === 'idle' ? null : previous?.activeTurnId ?? null
  let items: ItemView[] = []

  for (const turnValue of arrayOf(raw.turns)) {
    const turn = asRecord(turnValue)
    const turnStreaming = scalarText(turn?.status) === 'inProgress'
    if (turnStreaming) {
      status = 'running'
      activeTurnId = idValue(turn?.id) || activeTurnId
    }
    let view: ThreadView = { id, status, activeTurnId, items, pendingApprovals: [] }
    view = mergeTurnItems(view, turnValue, turnStreaming)
    items = view.items
  }

  if (items.length === 0 && Array.isArray(raw.items)) {
    for (let index = 0; index < raw.items.length; index++) {
      const candidate = itemViewFromRaw(raw.items[index], index, false)
      items = replaceItem(items, candidate.id, () => candidate, (existing) => mergeItemView(existing, candidate))
    }
  }

  const next: ThreadView = {
    id,
    status,
    activeTurnId,
    items,
    pendingApprovals: previous?.pendingApprovals ?? [],
  }
  if (previous?.tokenUsage !== undefined) next.tokenUsage = previous.tokenUsage
  if (status === 'error') next.error = previous?.error ?? 'Thread error'
  return { threads: { ...s.threads, [id]: next } }
}

export function applyNotification(s: ConversationState, n: ServerNotification): ConversationState {
  const envelope = asRecord(n as unknown)
  if (!envelope) return s
  const method = scalarText(envelope.method)
  const params = asRecord(envelope.params) ?? {}

  switch (method) {
    case 'thread/started': {
      const thread = asRecord(params.thread)
      const id = idValue(thread?.id)
      if (!id) return s
      const status = statusFromValue(thread?.status)
      return withThread(s, id, (current) => {
        let next: ThreadView = {
          ...current,
          status,
          activeTurnId: status === 'idle' ? null : current.activeTurnId,
        }
        if (status !== 'error') next = clearError(next)
        if (thread && Array.isArray(thread.turns)) {
          for (const turn of thread.turns) next = mergeTurnItems(next, turn, false)
        }
        return next
      })
    }
    case 'thread/status/changed': {
      const id = threadIdFrom(params)
      if (!id) return s
      return withStatus(s, id, statusFromValue(params.status))
    }
    case 'turn/started': {
      const id = threadIdFrom(params)
      if (!id) return s
      const turnId = turnIdFrom(params)
      return withThread(s, id, (current) => {
        let next: ThreadView = {
          ...clearError(current),
          status: 'running',
          activeTurnId: turnId || current.activeTurnId,
        }
        next = mergeTurnItems(next, params.turn, true)
        return next
      })
    }
    case 'turn/completed': {
      const id = threadIdFrom(params)
      if (!id) return s
      const turn = asRecord(params.turn)
      const turnStatus = scalarText(turn?.status) || 'completed'
      const failed = turnStatus === 'failed' || turnStatus === 'interrupted'
      const message =
        errorText(turn?.error) ??
        (turnStatus === 'interrupted' ? 'Turn interrupted' : turnStatus === 'failed' ? 'Turn failed' : undefined)
      return withThread(s, id, (current) => {
        let next = mergeTurnItems(current, params.turn, false)
        next = finalizeItems(next)
        next = {
          ...next,
          status: failed ? 'error' : 'idle',
          activeTurnId: null,
        }
        if (message) next.error = message
        else delete next.error
        return next
      })
    }
    case 'item/started': {
      const rawItem = params.item
      const streaming = scalarText(asRecord(rawItem)?.status) !== 'completed'
      return withItem(
        s,
        params,
        (id) => itemViewFromRaw(rawItem, 0, streaming),
        () => itemViewFromRaw(rawItem, 0, streaming),
        true,
      )
    }
    case 'item/completed': {
      const rawItem = params.item
      return withItem(
        s,
        params,
        (id) => itemViewFromRaw(rawItem, 0, false),
        (existing) => mergeItemView(existing, itemViewFromRaw(rawItem, 0, false)),
        false,
      )
    }
    case 'item/agentMessage/delta': {
      const delta = scalarText(params.delta)
      return withItem(
        s,
        params,
        (id) => ({ kind: 'agent', id, text: delta, streaming: true }),
        (item) =>
          item.kind === 'agent'
            ? { ...item, text: item.text + delta, streaming: true }
            : { kind: 'agent', id: item.id, text: delta, streaming: true },
        true,
      )
    }
    case 'item/reasoning/summaryTextDelta': {
      const delta = scalarText(params.delta)
      const index = indexValue(params.summaryIndex)
      return withItem(
        s,
        params,
        (id) => ({ kind: 'reasoning', id, summary: appendSummaryText('', index, delta), streaming: true }),
        (item) => {
          const summary = item.kind === 'reasoning' ? item.summary : ''
          return {
            kind: 'reasoning',
            id: item.id,
            summary: appendSummaryText(summary, index, delta),
            streaming: true,
          }
        },
        true,
      )
    }
    case 'item/reasoning/summaryPartAdded': {
      const index = indexValue(params.summaryIndex)
      return withItem(
        s,
        params,
        (id) => ({ kind: 'reasoning', id, summary: addSummaryPart('', index), streaming: true }),
        (item) => {
          const summary = item.kind === 'reasoning' ? item.summary : ''
          return { kind: 'reasoning', id: item.id, summary: addSummaryPart(summary, index), streaming: true }
        },
        true,
      )
    }
    case 'item/reasoning/textDelta': {
      const delta = scalarText(params.delta)
      return withItem(
        s,
        params,
        (id) => ({ kind: 'reasoning', id, summary: delta, streaming: true }),
        (item) => {
          const summary = item.kind === 'reasoning' ? item.summary : ''
          return {
            kind: 'reasoning',
            id: item.id,
            summary: summary ? `${summary}${SUMMARY_SEPARATOR}${delta}` : delta,
            streaming: true,
          }
        },
        true,
      )
    }
    case 'item/commandExecution/outputDelta': {
      const delta = scalarText(params.delta)
      return withItem(
        s,
        params,
        (id) => ({ kind: 'command', id, command: '', output: delta, exitCode: null, status: 'inProgress' }),
        (item) =>
          item.kind === 'command'
            ? { ...item, output: item.output + delta, status: item.status || 'inProgress' }
            : { kind: 'command', id: item.id, command: '', output: delta, exitCode: null, status: 'inProgress' },
        true,
      )
    }
    case 'item/fileChange/outputDelta': {
      const delta = scalarText(params.delta)
      return withItem(
        s,
        params,
        (id) => ({
          kind: 'fileChange',
          id,
          changes: [{ path: PATCH_OUTPUT_PATH, kind: PATCH_OUTPUT_KIND, diff: delta }],
          status: 'inProgress',
        }),
        (item) => appendFileChangeOutput(item, delta),
        true,
      )
    }
    case 'item/fileChange/patchUpdated': {
      const changes = fileChanges(params.changes)
      return withItem(
        s,
        params,
        (id) => ({ kind: 'fileChange', id, changes, status: 'inProgress' }),
        (item) =>
          item.kind === 'fileChange'
            ? mergeItemView(item, { ...item, changes })
            : { kind: 'fileChange', id: item.id, changes, status: 'inProgress' },
        false,
      )
    }
    case 'serverRequest/resolved': {
      const requestId = asRequestId(params.requestId)
      return requestId === null ? s : resolveServerRequest(s, requestId)
    }
    case 'thread/tokenUsage/updated': {
      const id = threadIdFrom(params)
      if (!id) return s
      return withThread(s, id, (thread) => ({
        ...thread,
        tokenUsage: params.tokenUsage ?? thread.tokenUsage,
      }))
    }
    case 'error': {
      const id = threadIdFrom(params)
      if (!id) return s
      const message = errorText(params.error) ?? 'Codex error'
      const willRetry = params.willRetry === true
      return withThread(s, id, (thread) => ({
        ...thread,
        status: willRetry ? 'running' : 'error',
        error: message,
        activeTurnId: willRetry ? idValue(params.turnId) || thread.activeTurnId : null,
      }))
    }
    default:
      return s
  }
}

function commandDetail(params: JsonRecord): string {
  const command = commandText(params.command)
  const cwd = scalarText(params.cwd)
  const reason = scalarText(params.reason)
  return [
    command ? `$ ${command}` : '',
    cwd ? `cwd: ${cwd}` : '',
    reason ? `原因: ${reason}` : '',
  ]
    .filter(Boolean)
    .join('\n') || '命令需要确认'
}

function fileChangeDetail(params: JsonRecord): string {
  const fileChanges = asRecord(params.fileChanges)
  const paths = fileChanges ? Object.keys(fileChanges) : []
  const reason = scalarText(params.reason)
  const grantRoot = scalarText(params.grantRoot)
  return [reason, ...paths, grantRoot].filter(Boolean).join('\n') || '文件改动需要确认'
}

function permissionsDetail(params: JsonRecord): string {
  const reason = scalarText(params.reason)
  const permissions = asRecord(params.permissions)
  return [reason, permissions ? safeStringify(permissions) : ''].filter(Boolean).join('\n') || '权限需要确认'
}

function otherDetail(method: string, params: JsonRecord): string {
  const reason = scalarText(params.reason) || scalarText(params.message)
  return [method, reason].filter(Boolean).join('\n') || '需要用户处理'
}

export function applyServerRequest(s: ConversationState, r: ServerRequest): ConversationState {
  const envelope = asRecord(r as unknown)
  if (!envelope) return s
  const requestId = asRequestId(envelope.id)
  const method = scalarText(envelope.method)
  if (requestId === null) return s
  const params = asRecord(envelope.params) ?? {}
  const threadId = threadIdFrom(params)
  if (!threadId) return s

  let kind: ApprovalView['kind']
  let title: string
  let detail: string
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      kind = 'command'
      title = '命令执行审批'
      detail = commandDetail(params)
      break
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      kind = 'fileChange'
      title = '文件改动审批'
      detail = fileChangeDetail(params)
      break
    case 'item/permissions/requestApproval':
      kind = 'permissions'
      title = '权限申请'
      detail = permissionsDetail(params)
      break
    default:
      kind = 'other'
      title = '其他请求'
      detail = otherDetail(method, params)
      break
  }

  const itemId = itemIdFrom(params)
  const approval: ApprovalView = {
    requestId,
    threadId,
    ...(itemId ? { itemId } : {}),
    kind,
    title,
    detail,
    method,
    raw: r,
  }

  return withThread(s, threadId, (thread) => {
    const pendingApprovals = [
      ...thread.pendingApprovals.filter((existing) => existing.requestId !== requestId),
      approval,
    ]
    const next: ThreadView = {
      ...clearError(thread),
      status: 'running',
      activeTurnId: turnIdFrom(params) || thread.activeTurnId,
      pendingApprovals,
    }
    return next
  })
}

export function resolveServerRequest(s: ConversationState, requestId: RequestId): ConversationState {
  const threads = { ...s.threads }
  let changed = false
  for (const [id, thread] of Object.entries(s.threads)) {
    const pendingApprovals = thread.pendingApprovals.filter((approval) => approval.requestId !== requestId)
    if (pendingApprovals.length !== thread.pendingApprovals.length) {
      threads[id] = { ...thread, pendingApprovals }
      changed = true
    }
  }
  return changed ? { threads } : s
}

function approvalParams(approval: ApprovalView): JsonRecord {
  const raw = asRecord(approval.raw)
  if (!raw) return {}
  return asRecord(raw.params) ?? raw
}

function grantedPermissions(value: unknown): GrantedPermissionProfile {
  const requested = asRecord(value)
  const granted: GrantedPermissionProfile = {}
  if (!requested) return granted
  const network = asRecord(requested.network)
  const fileSystem = asRecord(requested.fileSystem)
  if (network) granted.network = network as unknown as AdditionalNetworkPermissions
  if (fileSystem) granted.fileSystem = fileSystem as unknown as AdditionalFileSystemPermissions
  return granted
}

function legacyDecision(decision: ApprovalDecision): ReviewDecision {
  if (decision === 'accept') return 'approved'
  if (decision === 'acceptForSession') return 'approved_for_session'
  return { denied: { rejection: '用户拒绝该操作' } }
}

export function approvalResponse(a: ApprovalView, decision: ApprovalDecision): unknown {
  const params = approvalParams(a)
  switch (a.method) {
    case 'item/commandExecution/requestApproval': {
      const response: CommandExecutionRequestApprovalResponse = { decision }
      return response
    }
    case 'item/fileChange/requestApproval': {
      const response: FileChangeRequestApprovalResponse = { decision }
      return response
    }
    case 'item/permissions/requestApproval': {
      const response: PermissionsRequestApprovalResponse =
        decision === 'decline'
          ? { permissions: {}, scope: 'turn' }
          : {
              permissions: grantedPermissions(params.permissions),
              scope: decision === 'acceptForSession' ? 'session' : 'turn',
            }
      return response
    }
    case 'execCommandApproval': {
      const response: ExecCommandApprovalResponse = { decision: legacyDecision(decision) }
      return response
    }
    case 'applyPatchApproval': {
      const response: ApplyPatchApprovalResponse = { decision: legacyDecision(decision) }
      return response
    }
    default: {
      // 未知请求没有可推导的响应体，交由调用方按具体 method 处理
      return {}
    }
  }
}
