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
  UserInput,
} from './codex-types'
import type { ThreadHistoryCursor, ThreadHistoryPage } from './api'
import { describeSubagentItem, subagentThreadMetadata, type SubagentItemView, type SubagentThreadMetadata } from './subagents'
import { isActiveThread, isThreadOutcome, threadActivityFromStatus, type ThreadActivity, type ThreadOutcome } from './threadStatus'

export type ConversationState = { threads: Record<string, ThreadView> }

export type ThreadView = {
  id: string
  status: 'idle' | 'running' | 'error'
  activity?: ThreadActivity
  activeTurnId: string | null
  items: ItemView[]
  pendingApprovals: ApprovalView[]
  error?: string
  tokenUsage?: unknown
  subagent?: SubagentThreadMetadata
  historyCursor?: ThreadHistoryCursor | null
  /** 每轮的结果、计时与所含条目，用于显示工作过程和停止提示。 */
  turns?: TurnMeta[]
}

export type TurnMeta = {
  id: string
  outcome?: ThreadOutcome
  startedAtMs: number | null
  durationMs: number | null
  itemIds: string[]
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
      inputExtras?: Exclude<UserInput, { type: 'text' }>[]
      sentAt?: number
      /** 本地先渲染的占位消息；服务端回显到达后按位置替换，避免重复气泡。 */
      pending?: boolean
    }
  | { kind: 'agent'; id: string; text: string; streaming: boolean; completedAtMs?: number }
  | { kind: 'reasoning'; id: string; summary: string; streaming: boolean }
  | { kind: 'command'; id: string; command: string; cwd?: string; output: string; exitCode?: number | null; status: string }
  | { kind: 'fileChange'; id: string; changes: { path: string; kind: string; diff?: string }[]; status: string }
  | SubagentItemView
  | { kind: 'other'; id: string; type: string; summary: string; status?: string }

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
type ThreadSnapshot = Pick<Thread, 'id' | 'turns'> & Partial<Thread>
export type LoadableThread = ThreadSnapshot | { thread: ThreadSnapshot }

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

/** 草稿态还没有 threadId，借这个 id 先承载用户消息；真正会话建好后搬过去。 */
export const DRAFT_THREAD_ID = '__qn-draft__'

export function emptyState(): ConversationState {
  return { threads: {} }
}

export function failActiveThreads(state: ConversationState, error: string): ConversationState {
  const active = Object.values(state.threads).filter((thread) => thread.status === 'running' || thread.pendingApprovals.length > 0)
  if (!active.length) return state
  const threads = { ...state.threads }
  for (const thread of active) {
    threads[thread.id] = {
      ...finalizeItems(thread), status: 'error', activity: 'failed', activeTurnId: null, pendingApprovals: [], error,
    }
  }
  return { threads }
}

/** 把即将发送的 UserInput[] 转成一条本地占位气泡。 */
export function userItemFromInput(id: string, input: UserInput[]): Extract<ItemView, { kind: 'user' }> {
  const texts: string[] = []
  const images: string[] = []
  const files: string[] = []
  const skills: string[] = []
  for (const entry of input) {
    switch (entry.type) {
      case 'text':
        texts.push(entry.text)
        break
      case 'image':
        if ('url' in entry && entry.url) images.push(entry.url)
        break
      case 'localImage':
        images.push(entry.path)
        break
      case 'mention':
        files.push(entry.path)
        break
      case 'skill':
        skills.push(entry.name)
        break
      default:
        break
    }
  }
  const view: Extract<ItemView, { kind: 'user' }> = {
    kind: 'user',
    id,
    text: texts.join('\n'),
    pending: true,
  }
  if (images.length > 0) view.images = images
  if (files.length > 0) view.files = files
  if (skills.length > 0) view.skills = skills
  return view
}

/** 点击发送时立刻落一条气泡，不等建会话 / turn 的网络回包。 */
export function addOptimisticUser(
  s: ConversationState,
  threadId: string,
  item: Extract<ItemView, { kind: 'user' }>,
): ConversationState {
  if (!threadId) return s
  return withThread(s, threadId, (thread) => ({ ...thread, items: [...thread.items, item] }))
}

/** 新会话建好后把草稿里的占位搬进真实 thread，气泡位置不跳动。 */
export function moveOptimisticUsers(
  s: ConversationState,
  fromThreadId: string,
  toThreadId: string,
): ConversationState {
  const from = ownThread(s, fromThreadId)
  if (!from || !toThreadId) return s
  const pending = from.items.filter((item) => item.kind === 'user' && item.pending === true)
  if (pending.length === 0) return s
  const rest = from.items.filter((item) => !(item.kind === 'user' && item.pending === true))
  const threads = { ...s.threads }
  if (rest.length === 0) delete threads[fromThreadId]
  else threads[fromThreadId] = { ...from, items: rest }
  const target = threads[toThreadId] ?? emptyThread(toThreadId)
  threads[toThreadId] = { ...target, items: [...target.items, ...pending] }
  return { threads }
}

/** 发送失败时撤掉占位，不留一条并未发出去的消息；顺手清掉空的草稿线程。 */
export function dropOptimisticUsers(s: ConversationState, threadIds: string[], itemId?: string): ConversationState {
  const threads = { ...s.threads }
  let changed = false
  for (const id of threadIds) {
    const thread = threads[id]
    if (!thread) continue
    const items = thread.items.filter((item) => !(item.kind === 'user' && item.pending === true && (itemId === undefined || item.id === itemId)))
    if (items.length === thread.items.length) continue
    changed = true
    if (items.length === 0 && id === DRAFT_THREAD_ID) delete threads[id]
    else threads[id] = { ...thread, items }
  }
  return changed ? { threads } : s
}

/** 切换目标 / 会话 / 回到新会话时清掉遗留的草稿占位。 */
export function clearDraftThread(s: ConversationState): ConversationState {
  return dropOptimisticUsers(s, [DRAFT_THREAD_ID])
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

function statusFromActivity(activity: ThreadActivity = 'idle'): ThreadStatus {
  if (isActiveThread(activity)) return 'running'
  if (activity === 'failed') return 'error'
  return 'idle'
}

function withStatus(s: ConversationState, id: string, value: unknown): ConversationState {
  const activity = threadActivityFromStatus(value)
  if (!activity) return s
  const status = statusFromActivity(activity)
  return withThread(s, id, (thread) => {
    // Agent 的 idle 通知只表示已停止执行，不能覆盖最后一轮的结果。
    if (activity === 'idle' && isThreadOutcome(thread.activity)) return thread
    const next: ThreadView = {
      ...thread,
      status,
      activity,
      activeTurnId: status === 'running' ? thread.activeTurnId : null,
      pendingApprovals: status === 'running' ? thread.pendingApprovals : [],
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

/** 回显文本可能被桥接加上技能前缀/附件说明，优先按包含原文找对应占位。 */
function pendingUserIndex(items: ItemView[], text: string): number {
  const indices = items.flatMap((item, index) =>
    item.kind === 'user' && item.pending === true ? [index] : [],
  )
  if (indices.length === 0) return -1
  const matched = indices.find((index) => {
    const item = items[index]
    return item?.kind === 'user' && item.text.length > 0 && text.includes(item.text)
  })
  return matched ?? indices[0] ?? -1
}

function replaceItem(
  items: ItemView[],
  id: string,
  create: () => ItemView,
  update: (item: ItemView) => ItemView,
): ItemView[] {
  const index = items.findIndex((item) => item.id === id)
  const existing = index >= 0 ? items[index] : undefined
  const candidate = existing ? update(existing) : create()
  // 服务端回显的 userMessage 用自己的 id，文本也可能被改写（技能前缀、附件说明）；
  // 用最早一条本地占位承接它，既保持消息顺序也不会出现两条重复气泡。
  if (candidate.kind === 'user' && !candidate.pending) {
    const pendingIndex = pendingUserIndex(items, candidate.text)
    if (pendingIndex >= 0 && pendingIndex !== index) {
      const next = items.filter((_, position) => position !== pendingIndex)
      const target = index < 0 ? pendingIndex : pendingIndex < index ? index - 1 : index
      if (index < 0) next.splice(target, 0, candidate)
      else next[target] = candidate
      return next
    }
  }
  if (index < 0) return [...items, candidate]
  if (!existing || candidate === existing) return items
  const next = items.slice()
  next[index] = candidate
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
    const otherTurn = thread.status === 'running' && thread.activeTurnId && turnId && thread.activeTurnId !== turnId
    const isRunning = markRunning && !otherTurn
    // 新条目出现说明之前的文本/推理已经输出完：有的 Agent 不会为每条消息发 item/completed，
    // 不收尾的话上一条消息的流式光标会一直挂着。
    const base = otherTurn || thread.items.some((item) => item.id === itemId) ? thread : finalizeItems(thread)
    let next: ThreadView = {
      ...thread,
      items: replaceItem(base.items, itemId, () => create(itemId), update),
      status: isRunning ? 'running' : thread.status,
      activeTurnId: !otherTurn && (isRunning || thread.status === 'running') && turnId ? turnId : thread.activeTurnId,
    }
    if (isRunning) {
      if (next.activity !== 'pending' && next.activity !== 'input') next.activity = 'running'
      delete next.error
    }
    const owner = turnId || thread.activeTurnId
    if (owner) next = upsertTurnMeta(next, owner, { itemIds: [itemId] })
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

function itemViewFromRaw(raw: unknown, index: number, streaming: boolean, timestamp?: number | null, completionTime?: number | null): ItemView {
  const item = asRecord(raw)
  if (!item) return { kind: 'other', id: `unknown-${index}`, type: 'unknown', summary: '' }

  const type = scalarText(item.type) || 'unknown'
  const id = idValue(item.id) || `${type}-${index}`
  const status = scalarText(item.status) || (streaming ? 'inProgress' : 'completed')

  switch (type) {
    case 'userMessage': {
      const inputExtras = arrayOf(item.content).filter((value) => {
        const type = asRecord(value)?.type
        return type === 'image' || type === 'localImage' || type === 'audio' || type === 'localAudio' || type === 'mention' || type === 'skill'
      }) as Exclude<UserInput, { type: 'text' }>[]
      const sentAt = optionalNumber(item.startedAtMs) ?? optionalNumber(item.completedAtMs) ?? timestamp
      return {
        kind: 'user', id, text: userText(item.content) || scalarText(item.text), ...userExtras(item.content),
        ...(inputExtras.length ? { inputExtras } : {}),
        ...(sentAt != null && sentAt > 0 ? { sentAt } : {}),
      }
    }
    case 'agentMessage': {
      const completedAtMs = positive(item.completedAtMs) ?? completionTime
      return { kind: 'agent', id, text: scalarText(item.text), streaming: streaming && !completedAtMs,
        ...(completedAtMs ? { completedAtMs } : {}) }
    }
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
    case 'contextCompaction':
      return { kind: 'other', id, type, status, summary: streaming ? '正在压缩会话…' : '已压缩会话上下文' }
    default: {
      const subagent = describeSubagentItem(item, id)
      if (subagent) return subagent
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
      streaming: (candidate.completedAtMs ?? existing.completedAtMs) ? false : candidate.streaming,
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
    return {
      ...existing,
      ...candidate,
      pending: candidate.pending,
      text: longer(existing.text, candidate.text),
    }
  }
  if (existing.kind === 'other' && candidate.kind === 'other') {
    return { ...candidate, summary: longer(existing.summary, candidate.summary) }
  }
  return candidate
}

export function mergeSubagentHistory(
  history: readonly ItemView[],
  live: readonly ItemView[],
  beforeRead: readonly ItemView[],
): ItemView[] {
  const items = new Map(history.map((item) => [item.id, item]))
  const baseline = new Map(beforeRead.map((item) => [item.id, item]))
  for (const item of live) {
    const previous = items.get(item.id)
    if (!previous) items.set(item.id, item)
    else if (baseline.get(item.id) !== item) items.set(item.id, mergeItemView(previous, item))
  }
  return [...items.values()]
}

type TurnPhase = 'started' | 'completed' | 'loaded'

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 部分适配器在结束时才填 startedAt，优先沿用 turn/started 时记下的起点。 */
function turnMeta(
  existing: TurnMeta | undefined,
  turnId: string,
  patch: { record?: JsonRecord | null; phase?: TurnPhase; itemIds?: string[] },
): TurnMeta {
  const record = patch.record ?? null
  const outcome = isThreadOutcome(record?.status) ? record.status : existing?.outcome
  const startedSec = positive(record?.startedAt)
  const completedSec = positive(record?.completedAt)
  const startedAtMs =
    existing?.startedAtMs ?? (startedSec ? startedSec * 1000 : patch.phase === 'started' ? Date.now() : null)

  let durationMs = existing?.durationMs ?? null
  const explicit = record?.durationMs
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) durationMs = explicit
  else if (durationMs === null && startedAtMs !== null) {
    const completedAtMs = completedSec === null ? null : completedSec * 1000
    if (completedAtMs !== null && completedAtMs >= startedAtMs) durationMs = completedAtMs - startedAtMs
    else if (patch.phase === 'completed' && existing?.startedAtMs != null) {
      durationMs = Math.max(0, Date.now() - startedAtMs)
    }
  }

  const itemIds = new Set(existing?.itemIds)
  for (const id of patch.itemIds ?? []) if (id) itemIds.add(id)
  if (
    existing &&
    existing.outcome === outcome &&
    existing.startedAtMs === startedAtMs &&
    existing.durationMs === durationMs &&
    existing.itemIds.length === itemIds.size
  ) {
    return existing
  }
  return { id: turnId, ...(outcome ? { outcome } : {}), startedAtMs, durationMs, itemIds: [...itemIds] }
}

function upsertTurnMeta(
  thread: ThreadView,
  turnId: string,
  patch: Parameters<typeof turnMeta>[2],
): ThreadView {
  if (!turnId) return thread
  const turns = thread.turns ?? []
  const index = turns.findIndex((turn) => turn.id === turnId)
  const existing = turns[index]
  const meta = turnMeta(existing, turnId, patch)
  if (meta === existing) return thread
  const next = turns.slice()
  if (index >= 0) next[index] = meta
  else next.push(meta)
  return { ...thread, turns: next }
}

function mergeTurnItems(thread: ThreadView, turn: unknown, streaming: boolean, phase?: TurnPhase): ThreadView {
  const record = asRecord(turn)
  if (!record) return thread
  const ids: string[] = []
  let items = thread.items
  const rawItems = arrayOf(record.items)
  const startedAt = optionalNumber(record.startedAt)
  for (let index = 0; index < rawItems.length; index++) {
    const timestamp = index === 0 && startedAt ? startedAt * 1000 : undefined
    // 进行中的轮次只有最后一条可能还在输出，前面的条目都已完成。
    const candidate = itemViewFromRaw(rawItems[index], index, streaming && index === rawItems.length - 1, timestamp)
    ids.push(candidate.id)
    items = replaceItem(items, candidate.id, () => candidate, (existing) => mergeItemView(existing, candidate))
  }
  const next = items === thread.items ? thread : { ...thread, items }
  return phase ? upsertTurnMeta(next, idValue(record.id), { record, phase, itemIds: ids }) : next
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
  const reportedActivity = threadActivityFromStatus(raw.status)
  let status = statusFromActivity(reportedActivity)
  let activeTurnId: string | null = status === 'idle' ? null : previous?.activeTurnId ?? null
  // 历史一次性构建索引，避免每条条目都扫描并复制已加载的消息。
  const items = new Map<string, ItemView>()
  const replyTimes = new Map<string, number>()
  for (const item of previous?.items ?? []) {
    if (item.kind === 'agent' && item.completedAtMs) replyTimes.set(item.id, item.completedAtMs)
  }
  // 沿用实时记下的计时：历史里的时间戳可能缺失或只有秒级。
  const turns = new Map(previous?.turns?.map((turn) => [turn.id, turn]))
  const appendItems = (rawItems: unknown[], streaming: boolean, startedAt?: number | null) =>
    rawItems.map((rawItem, index) => {
      const timestamp = index === 0 && startedAt ? startedAt * 1000 : undefined
      // 历史里进行中的轮次只有最后一条可能还在输出，否则已完成的回复会一直挂着流式光标。
      const candidate = itemViewFromRaw(rawItem, index, streaming && index === rawItems.length - 1, timestamp)
      if (candidate.kind === 'agent' && candidate.completedAtMs === undefined) {
        const recorded = replyTimes.get(candidate.id)
        if (recorded !== undefined) {
          candidate.completedAtMs = recorded
          candidate.streaming = false
        }
      }
      const existing = items.get(candidate.id)
      items.set(candidate.id, existing ? mergeItemView(existing, candidate) : candidate)
      return candidate.id
    })

  // 只看最后一轮：历史里早先失败、之后又成功的轮次不该让整个会话显示为失败。
  let lastTurnError: string | undefined
  let lastTurnOutcome: ThreadOutcome | undefined
  for (const turnValue of arrayOf(raw.turns)) {
    const turn = asRecord(turnValue)
    lastTurnOutcome = isThreadOutcome(turn?.status) ? turn.status : undefined
    lastTurnError = lastTurnOutcome === 'failed' ? errorText(turn?.error) ?? 'Turn failed' : undefined
    const turnStreaming = scalarText(turn?.status) === 'inProgress'
    if (turnStreaming) {
      status = 'running'
      activeTurnId = idValue(turn?.id) || activeTurnId
    }
    if (!turn) continue
    const turnId = idValue(turn.id)
    const itemIds = appendItems(arrayOf(turn.items), turnStreaming, optionalNumber(turn.startedAt))
    if (turnId) {
      turns.set(turnId, turnMeta(turns.get(turnId), turnId, {
        record: turn, phase: turnStreaming ? 'started' : 'loaded', itemIds,
      }))
    }
  }

  if (!items.size) appendItems(arrayOf(raw.items), false)

  const next: ThreadView = {
    id,
    status,
    activeTurnId,
    items: [...items.values()],
    pendingApprovals: previous?.pendingApprovals ?? [],
  }
  const subagent = subagentThreadMetadata(raw) ?? previous?.subagent
  if (subagent) next.subagent = subagent
  if (previous?.tokenUsage !== undefined) next.tokenUsage = previous.tokenUsage
  if (turns.size || previous?.turns) next.turns = [...turns.values()]
  if (status === 'running') {
    next.activity = reportedActivity === 'pending' || reportedActivity === 'input' ? reportedActivity : 'running'
  } else {
    next.activity = reportedActivity === 'failed' ? 'failed' : lastTurnOutcome ?? reportedActivity ?? 'idle'
  }
  if (status === 'idle' && lastTurnError) {
    next.status = 'error'
    next.error = lastTurnError
  } else if (status === 'error') next.error = previous?.error ?? 'Thread error'
  return { threads: { ...s.threads, [id]: next } }
}

export function loadRecentThreadHistory(
  s: ConversationState,
  thread: Thread,
  earlier: ThreadHistoryCursor | null,
  before: ThreadView | undefined,
): ConversationState {
  const loaded = loadThread(s, thread)
  const live = ownThread(s, thread.id)
  const recent = loaded.threads[thread.id]!
  const next = { ...recent, historyCursor: earlier }
  if (live) {
    const activeItems = live.activeTurnId && live.activeTurnId === recent.activeTurnId
      ? new Set(live.turns?.find((turn) => turn.id === live.activeTurnId)?.itemIds) : undefined
    const oldItems = new Map(before?.items.map((item) => [item.id, item]))
    const available = new Set(recent.items.map((item) => item.id))
    const changed = live.items.filter((item) => oldItems.get(item.id) !== item ||
      (activeItems?.has(item.id) && !available.has(item.id)))
    if (changed.length) next.items = mergeSubagentHistory(recent.items, changed, before?.items ?? [])
    if (live !== before && (live.status !== before?.status || live.activeTurnId !== before?.activeTurnId ||
        live.activity !== before?.activity || live.error !== before?.error)) {
      const { status, activeTurnId, activity, error } = live
      Object.assign(next, { status, activeTurnId, activity, error })
    }
  }
  return { threads: { ...loaded.threads, [thread.id]: next } }
}

export function prependThreadHistory(s: ConversationState, id: string, page: ThreadHistoryPage): ConversationState {
  const current = ownThread(s, id)
  if (!current) return s
  const older = loadThread(emptyState(), { id, turns: page.turns }).threads[id]!
  const currentItems = new Set(current.items.map((item) => item.id))
  const turns = new Map(older.turns?.map((turn) => [turn.id, turn]))
  for (const turn of current.turns ?? []) {
    const previous = turns.get(turn.id)
    turns.set(turn.id, previous ? {
      ...turn,
      outcome: turn.outcome ?? previous.outcome,
      startedAtMs: turn.startedAtMs ?? previous.startedAtMs,
      durationMs: turn.durationMs ?? previous.durationMs,
      itemIds: [...new Set([...previous.itemIds, ...turn.itemIds])],
    } : turn)
  }
  return withThread(s, id, () => ({
    ...current,
    items: [...older.items.filter((item) => !currentItems.has(item.id)), ...current.items],
    turns: [...turns.values()],
    historyCursor: page.earlier,
  }))
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
      const activity = threadActivityFromStatus(thread?.status)
      const status = statusFromActivity(activity)
      return withThread(s, id, (current) => {
        let next: ThreadView = {
          ...current,
          status,
          activity,
          activeTurnId: status === 'idle' ? null : current.activeTurnId,
        }
        const subagent = thread && subagentThreadMetadata(thread)
        if (subagent) next.subagent = subagent
        if (status !== 'error') next = clearError(next)
        if (thread && Array.isArray(thread.turns)) {
          for (const turn of thread.turns) next = mergeTurnItems(next, turn, false, 'loaded')
        }
        return next
      })
    }
    case 'thread/status/changed': {
      const id = threadIdFrom(params)
      if (!id) return s
      return withStatus(s, id, params.status)
    }
    case 'turn/started': {
      const id = threadIdFrom(params)
      if (!id) return s
      const turnId = turnIdFrom(params)
      return withThread(s, id, (current) => {
        let next: ThreadView = {
          ...clearError(current),
          status: 'running',
          activity: current.activity === 'pending' || current.activity === 'input' ? current.activity : 'running',
          activeTurnId: turnId || current.activeTurnId,
        }
        next = mergeTurnItems(next, params.turn, true, 'started')
        // turn/started 可能不带 turn 对象，计时起点仍要记下。
        if (turnId) next = upsertTurnMeta(next, turnId, { phase: 'started' })
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
        let next = mergeTurnItems(current, params.turn, false, 'completed')
        const completedId = idValue(turn?.id) || idValue(params.turnId) || current.activeTurnId || ''
        if (completedId && !turn) next = upsertTurnMeta(next, completedId, { phase: 'completed' })
        // 旧轮次的中断结果可能迟到，此时只合并历史，保留当前轮的运行状态和审批。
        if (current.status === 'running' && current.activeTurnId && completedId !== current.activeTurnId) return next
        next = finalizeItems(next)
        next = {
          ...next,
          status: failed ? 'error' : 'idle',
          activity: isThreadOutcome(turnStatus) ? turnStatus : 'completed',
          activeTurnId: null,
          pendingApprovals: [],
        }
        if (message) next.error = message
        else delete next.error
        return next
      })
    }
    case 'item/started': {
      const rawItem = params.item
      const streaming = scalarText(asRecord(rawItem)?.status) !== 'completed'
      const started = itemViewFromRaw(rawItem, 0, streaming, optionalNumber(params.startedAtMs))
      return withItem(
        s,
        params,
        () => started,
        (existing) => started.kind === 'user' ? mergeItemView(existing, started) : started,
        true,
      )
    }
    case 'item/completed': {
      const rawItem = params.item
      const completedAtMs = positive(params.completedAtMs)
      const completed = itemViewFromRaw(rawItem, 0, false, completedAtMs, completedAtMs)
      return withItem(
        s,
        params,
        () => completed,
        (existing) => mergeItemView(existing, completed),
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
      const turnId = turnIdFrom(params)
      const message = errorText(params.error) ?? 'Codex error'
      const willRetry = params.willRetry === true
      return withThread(s, id, (thread) => {
        if (thread.status === 'running' && thread.activeTurnId && turnId && turnId !== thread.activeTurnId) return thread
        return {
          ...thread,
          status: willRetry ? 'running' : 'error',
          activity: willRetry ? 'running' : 'failed',
          error: message,
          activeTurnId: willRetry ? turnId || thread.activeTurnId : null,
          pendingApprovals: willRetry ? thread.pendingApprovals : [],
        }
      })
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
      activity: thread.activity === 'pending' || thread.activity === 'input' ? thread.activity : 'running',
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
      const activity = pendingApprovals.length === 0 && thread.activity === 'pending' ? 'running' : thread.activity
      threads[id] = { ...thread, activity, pendingApprovals }
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
