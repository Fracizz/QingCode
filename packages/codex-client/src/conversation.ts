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
import { t, translateMessage } from '../../protocol/src/i18n'
import type { ThreadHistoryCursor, ThreadHistoryPage } from './api'
import { parseBackgroundTasks, type BackgroundTaskView } from './agentControls'
import { parsePlan, type PlanView } from './plan'
import { planExitText } from './planMode'
import { describeSubagentItem, subagentThreadMetadata, type SubagentItemView, type SubagentThreadMetadata } from './subagents'
import { USER_INPUT_METHOD, parseUserInputQuestions, userInputResponse, type UserInputQuestion } from './userInput'
import { ELICITATION_METHOD, elicitationAnswer, elicitationDecision, elicitationDetail, elicitationView } from './elicitation'
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
  /** Thread 上记录的模型与推理强度（Codex 为该会话最近一次的配置），用于恢复会话时的初始选择。 */
  /** serviceTier：undefined 表示历史没回报（如 thread/read），null 表示未开快速等档位。 */
  savedConfig?: { model: string; effort: string | null; serviceTier?: string | null }
  /** 本机最近一次发送时显式指定的模型与强度，用于判断下一轮是否中途切换了模型。 */
  lastTurnConfig?: { model: string; effort: string | null }
  /** 最新的计划 / TODO 清单；steps 为空表示已清空。 */
  plan?: PlanView
  /** 轮次外仍在运行的后台任务（全量替换）。 */
  backgroundTasks?: BackgroundTaskView[]
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
      clientId?: string
      steering?: 'currentTurn' | 'nextTurn'
      text: string
      /** 图片：data URL / http URL（可直接显示），或目标机上的本地图片路径（只显示文件名）。 */
      images?: string[]
      /** 用户附加的文件（目标机绝对路径）。 */
      files?: string[]
      /** 触发的技能名。 */
      skills?: string[]
      inputExtras?: Exclude<UserInput, { type: 'text' }>[]
      sentAt?: number
      /** 本地先渲染的占位消息，收到服务端回显后替换。 */
      pending?: boolean
    }
  | { kind: 'agent'; id: string; text: string; streaming: boolean; completedAtMs?: number }
  | { kind: 'reasoning'; id: string; summary: string; streaming: boolean }
  | { kind: 'command'; id: string; command: string; cwd?: string; output: string; exitCode?: number | null; status: string }
  | { kind: 'fileChange'; id: string; changes: { path: string; kind: string; diff?: string }[]; status: string }
  | SubagentItemView
  | { kind: 'backgroundTask'; id: string; status: 'completed' | 'failed' | 'stopped' | 'event' | 'message'; summary: string; result: string }
  /** plan 仅退出计划模式的工具条目带有：待批准的完整计划。 */
  | { kind: 'other'; id: string; type: string; summary: string; status?: string; plan?: string }
  /** 本机插入的提示（如中途切换模型），不来自 Agent；anchor 为它所在那条用户消息的 clientId。 */
  | { kind: 'notice'; id: string; text: string; anchor?: string }

export function backgroundTaskLabel(status: Extract<ItemView, { kind: 'backgroundTask' }>['status']): string {
  if (status === 'failed') return t('后台任务失败')
  if (status === 'stopped') return t('后台任务已停止')
  if (status === 'event') return t('后台任务动态')
  if (status === 'message') return t('来自其他 Agent 的消息')
  return t('后台任务已完成')
}

export type ApprovalView = {
  requestId: RequestId
  threadId: string
  itemId?: string
  kind: 'command' | 'fileChange' | 'permissions' | 'other'
  title: string
  detail: string
  method: string
  raw: unknown
  /** 提问或表单的问题；有值时界面按问答渲染，而不是允许/拒绝。 */
  questions?: UserInputQuestion[]
  /** 问答卡片上方的说明。 */
  intro?: string
  /** 不回答按钮的文案；缺省为“跳过”。 */
  skipLabel?: string
  /** 可选的审批决定；缺省表示三种都可以。 */
  decisions?: ApprovalDecision[]
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
  const active = (thread: ThreadView) => thread.status === 'running' || thread.pendingApprovals.length > 0
  const affected = Object.values(state.threads).filter((thread) => active(thread) || thread.backgroundTasks?.length)
  if (!affected.length) return state
  const threads = { ...state.threads }
  for (const thread of affected) {
    const next: ThreadView = active(thread) ? {
      ...finalizeItems(thread), status: 'error', activity: 'failed', activeTurnId: null, pendingApprovals: [], error,
    } : { ...thread }
    // 后台任务随 Agent 进程结束，进程没了就不会再发清空通知。
    delete next.backgroundTasks
    threads[thread.id] = next
  }
  return { threads }
}

/**
 * 应用 qingcode/backgroundTasks/list 的回包。before 是发请求前看到的列表：
 * 期间收到过更新通知时，回包可能更旧，丢弃它。
 */
export function applyBackgroundTaskList(
  s: ConversationState,
  threadId: string,
  tasks: BackgroundTaskView[],
  before: BackgroundTaskView[] | undefined,
): ConversationState {
  const current = ownThread(s, threadId)
  if (!current || current.backgroundTasks !== before || (!tasks.length && !before?.length)) return s
  return withThread(s, threadId, (thread) => ({ ...thread, backgroundTasks: tasks }))
}

/** 补读到的更早清单只在还没有任何清单时采用。 */
export function applyEarlierPlan(s: ConversationState, threadId: string, plan: PlanView): ConversationState {
  const current = ownThread(s, threadId)
  if (!current || current.plan) return s
  return withThread(s, threadId, (thread) => ({ ...thread, plan }))
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

/** 重新加载历史时，把本机插入的提示放回它所在的用户消息之前；找不到那条消息就丢弃。 */
function restoreNotices(previous: readonly ItemView[] | undefined, items: ItemView[]): ItemView[] {
  const notices = previous?.filter((item): item is Extract<ItemView, { kind: 'notice' }> => item.kind === 'notice' && !!item.anchor)
  if (!notices?.length) return items
  const out: ItemView[] = []
  const placed = new Set<string>()
  for (const item of items) {
    if (item.kind === 'user') {
      for (const notice of notices) {
        if (!placed.has(notice.id) && (notice.anchor === item.id || notice.anchor === item.clientId)) {
          out.push(notice)
          placed.add(notice.id)
        }
      }
    }
    if (item.kind !== 'notice' || !placed.has(item.id)) out.push(item)
  }
  return out
}

/**
 * 记下本轮显式指定的模型与强度；notice 不为空时在本轮的用户消息之前插入提示
 * （消息还没回显时放在末尾，回显的消息会排在它后面）。
 */
export function noteTurnConfig(
  s: ConversationState,
  threadId: string,
  config: { model: string; effort: string | null },
  notice?: { id: string; text: string; anchor: string },
): ConversationState {
  if (!threadId) return s
  return withThread(s, threadId, (thread) => {
    const next = { ...thread, lastTurnConfig: config }
    if (!notice || thread.items.some((item) => item.id === notice.id)) return next
    const item: ItemView = { kind: 'notice', ...notice }
    const index = thread.items.findIndex((entry) =>
      entry.kind === 'user' && (entry.id === notice.anchor || entry.clientId === notice.anchor))
    const items = index >= 0
      ? [...thread.items.slice(0, index), item, ...thread.items.slice(index)]
      : [...thread.items, item]
    return { ...next, items }
  })
}

/** 点击发送时立刻落一条气泡，不等建会话 / turn 的网络回包。 */
export function addOptimisticUser(
  s: ConversationState,
  threadId: string,
  item: Extract<ItemView, { kind: 'user' }>,
): ConversationState {
  if (!threadId) return s
  return withThread(s, threadId, (thread) => thread.items.some((entry) => entry.id === item.id)
    ? thread : { ...thread, items: [...thread.items, item] })
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
  const existing = new Set(target.items.map((item) => item.id))
  threads[toThreadId] = { ...target, items: [...target.items, ...pending.filter((item) => !existing.has(item.id))] }
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

/**
 * 停止按钮要用的 turn id。会话显示运行中却没记下 activeTurnId 时（例如重连后只收到
 * thread/status/changed、错过了 turn/started），退回最后一个未结束的轮次；仍没有则返回空串，
 * Claude/pi 只按 threadId 中断。返回 null 表示确实没有可中断的轮次。
 */
export function interruptTurnIdOf(view: ThreadView | undefined): string | null {
  if (!view) return null
  if (view.activeTurnId) return view.activeTurnId
  if (view.status !== 'running') return null
  return view.turns?.findLast((turn) => !turn.outcome)?.id ?? ''
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

// clientId 标识同一次用户提交，实时事件和历史条目的原始 id 可能不同。
function userMessageClientId(item: JsonRecord | null): string {
  return item?.type === 'userMessage' && typeof item.clientId === 'string' ? item.clientId : ''
}

function itemIdFrom(params: JsonRecord): string {
  const item = asRecord(params.item)
  return (
    userMessageClientId(item) ||
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
  // 旧版回显没有 clientId，只为首次出现的条目匹配本地占位。
  if (index < 0 && candidate.kind === 'user' && !candidate.clientId && !candidate.pending) {
    const pendingIndex = pendingUserIndex(items, candidate.text)
    if (pendingIndex >= 0) {
      const next = items.slice()
      next[pendingIndex] = candidate
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
  backgroundTask = false,
): ConversationState {
  const threadId = threadIdFrom(params)
  const itemId = itemIdFrom(params)
  if (!threadId || !itemId) return s
  const turnId = turnIdFrom(params)

  return withThread(s, threadId, (thread) => {
    const otherTurn = thread.status === 'running' && thread.activeTurnId && turnId && thread.activeTurnId !== turnId
    // 已结束轮次的迟到帧（重连回放晚于实时帧等）只合并内容，不能把会话拉回运行中，
    // 否则不会再有 turn/completed，界面会一直显示思考中。
    const finished = finishedTurn(thread, turnId, itemId)
    const isRunning = markRunning && !otherTurn && !finished
    // 新条目出现说明之前的文本/推理已经输出完：有的 Agent 不会为每条消息发 item/completed，
    // 不收尾的话上一条消息的流式光标会一直挂着。
    const base = backgroundTask || otherTurn || thread.items.some((item) => item.id === itemId) ? thread : finalizeItems(thread)
    let next: ThreadView = {
      ...thread,
      items: replaceItem(base.items, itemId, () => create(itemId), update),
      status: isRunning ? 'running' : thread.status,
      activeTurnId: !otherTurn && !finished && (isRunning || thread.status === 'running') && turnId ? turnId : thread.activeTurnId,
    }
    if (isRunning) {
      if (next.activity !== 'pending' && next.activity !== 'input') next.activity = 'running'
      delete next.error
    }
    const owner = turnId || (!backgroundTask && thread.activeTurnId)
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
      const clientId = userMessageClientId(item)
      const inputExtras = arrayOf(item.content).filter((value) => {
        const type = asRecord(value)?.type
        return type === 'image' || type === 'localImage' || type === 'audio' || type === 'localAudio' || type === 'mention' || type === 'skill'
      }) as Exclude<UserInput, { type: 'text' }>[]
      const sentAt = optionalNumber(item.startedAtMs) ?? optionalNumber(item.completedAtMs) ?? timestamp
      const steering = item.steering === 'currentTurn' || item.steering === 'nextTurn' ? item.steering : undefined
      return {
        kind: 'user', id: clientId || id, text: userText(item.content) || scalarText(item.text), ...userExtras(item.content),
        ...(clientId ? { clientId } : {}),
        ...(steering ? { steering } : {}),
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
    case 'backgroundTaskNotification':
      return {
        kind: 'backgroundTask', id,
        status: status === 'failed' || status === 'stopped' || status === 'event' || status === 'message' ? status : 'completed',
        summary: scalarText(item.summary), result: scalarText(item.result),
      }
    case 'contextCompaction':
      return {
        kind: 'other', id, type, status,
        summary: status === 'failed' ? t('会话压缩失败') : status === 'interrupted' ? t('会话压缩已中断')
          : streaming ? t('正在压缩会话…') : t('已压缩会话上下文'),
      }
    default: {
      const subagent = describeSubagentItem(item, id)
      if (subagent) return subagent
      const plan = planExitText(item)
      if (plan !== undefined) return { kind: 'other', id, type, summary: scalarText(item.tool), status, plan }
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
  if (existing.kind === 'backgroundTask' && candidate.kind === 'backgroundTask') {
    return { ...candidate, summary: candidate.summary || existing.summary, result: candidate.result || existing.result }
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
    if (candidate.pending) return existing
    if (existing.pending) return candidate
    return {
      ...existing,
      ...candidate,
      text: longer(existing.text, candidate.text),
    }
  }
  if (existing.kind === 'other' && candidate.kind === 'other') {
    const plan = candidate.plan || existing.plan
    return { ...candidate, summary: longer(existing.summary, candidate.summary), ...(plan !== undefined ? { plan } : {}) }
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

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function turnMeta(
  existing: TurnMeta | undefined,
  turnId: string,
  patch: { record?: JsonRecord | null; itemIds?: string[] },
): TurnMeta {
  const record = patch.record ?? null
  const outcome = isThreadOutcome(record?.status) ? record.status : existing?.outcome
  const startedSec = positive(record?.startedAt)
  const completedSec = positive(record?.completedAt)
  const startedAtMs = startedSec === null ? existing?.startedAtMs ?? null : startedSec * 1000

  let durationMs = existing?.durationMs ?? null
  const explicit = record?.durationMs
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) durationMs = explicit
  else if (durationMs === null && startedAtMs !== null) {
    const completedAtMs = completedSec === null ? null : completedSec * 1000
    if (completedAtMs !== null && completedAtMs >= startedAtMs) durationMs = completedAtMs - startedAtMs
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

/** 条目所属轮次已有结果：优先按 turnId 判断，缺 turnId 时按条目归属判断。 */
function finishedTurn(thread: ThreadView, turnId: string, itemId: string): boolean {
  return thread.turns?.some((turn) => turn.outcome !== undefined &&
    (turnId ? turn.id === turnId : turn.itemIds.includes(itemId))) ?? false
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

function mergeTurnItems(thread: ThreadView, turn: unknown, streaming: boolean): ThreadView {
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
  const updated = items === thread.items ? thread : { ...thread, items }
  const plan = parsePlan(record.plan, idValue(record.id))
  return upsertTurnMeta(plan ? { ...updated, plan } : updated, idValue(record.id), { record, itemIds: ids })
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

  // 清单只挂在发生变化的轮次上，按轮次顺序取最后一份。
  let historyPlan: PlanView | undefined
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
    historyPlan = parsePlan(turn.plan, turnId) ?? historyPlan
    const itemIds = appendItems(arrayOf(turn.items), turnStreaming, optionalNumber(turn.startedAt))
    if (turnId) {
      turns.set(turnId, turnMeta(turns.get(turnId), turnId, {
        record: turn, itemIds,
      }))
    }
  }

  if (!items.size) appendItems(arrayOf(raw.items), false)

  const next: ThreadView = {
    id,
    status,
    activeTurnId,
    items: restoreNotices(previous?.items, [...items.values()]),
    pendingApprovals: previous?.pendingApprovals ?? [],
  }
  const subagent = subagentThreadMetadata(raw) ?? previous?.subagent
  if (subagent) next.subagent = subagent
  // thread/read 不回报服务档位，沿用之前 thread/resume 记下的值。
  const serviceTier = 'serviceTier' in raw
    ? (typeof raw.serviceTier === 'string' && raw.serviceTier ? raw.serviceTier : null)
    : previous?.savedConfig?.serviceTier
  const savedConfig = typeof raw.model === 'string' && raw.model
    ? {
        model: raw.model,
        effort: typeof raw.reasoningEffort === 'string' && raw.reasoningEffort ? raw.reasoningEffort : null,
        ...(serviceTier !== undefined ? { serviceTier } : {}),
      }
    : previous?.savedConfig
  if (savedConfig) next.savedConfig = savedConfig
  // 历史回报了模型时它就是最新配置（可能已被另一端改过），本机上一轮的记录不再作为比较基准。
  if (previous?.lastTurnConfig && !(typeof raw.model === 'string' && raw.model)) next.lastTurnConfig = previous.lastTurnConfig
  if (previous?.tokenUsage !== undefined) next.tokenUsage = previous.tokenUsage
  // Codex 历史不带清单、分页可能不含最新清单：没读到时沿用已知的。
  const plan = historyPlan ?? previous?.plan
  if (plan) next.plan = plan
  if (previous?.backgroundTasks) next.backgroundTasks = previous.backgroundTasks
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
    const changed = live.items.filter((item) => (item.kind === 'user' && item.pending) || oldItems.get(item.id) !== item ||
      (activeItems?.has(item.id) && !available.has(item.id)))
    if (changed.length) next.items = mergeSubagentHistory(recent.items, changed, before?.items ?? [])
    // 读历史期间收到的清单比历史新。
    if (live.plan && live.plan !== before?.plan) next.plan = live.plan
    if (live !== before &&(live.status !== before?.status || live.activeTurnId !== before?.activeTurnId ||
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
  const plan = current.plan ?? older.plan
  return withThread(s, id, () => ({
    ...current,
    ...(plan ? { plan } : {}),
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
          for (const turn of thread.turns) next = mergeTurnItems(next, turn, false)
        }
        return next
      })
    }
    case 'thread/status/changed': {
      const id = threadIdFrom(params)
      if (!id) return s
      return withStatus(s, id, params.status)
    }
    case 'turn/plan/updated': {
      const id = threadIdFrom(params)
      const plan = parsePlan(params, turnIdFrom(params))
      if (!id || !plan) return s
      return withThread(s, id, (thread) => ({ ...thread, plan }))
    }
    case 'qingcode/backgroundTasks/updated': {
      const id = threadIdFrom(params)
      if (!id || !Array.isArray(params.tasks)) return s
      const tasks = parseBackgroundTasks(params.tasks)
      // 没打开过的会话收到空列表时不必为它建视图。
      if (!tasks.length && !ownThread(s, id)) return s
      return withThread(s, id, (thread) => ({ ...thread, backgroundTasks: tasks }))
    }
    case 'thread/closed': {
      const id = threadIdFrom(params)
      if (!id || !ownThread(s, id)?.backgroundTasks) return s
      return withThread(s, id, (thread) => {
        const next = { ...thread }
        delete next.backgroundTasks
        return next
      })
    }
    case 'turn/started': {
      const id = threadIdFrom(params)
      if (!id) return s
      const turnId = turnIdFrom(params)
      return withThread(s, id, (current) => {
        // 乱序回放的 turn/started 晚于 turn/completed 到达时，只补条目。
        if (turnId && current.turns?.some((turn) => turn.id === turnId && turn.outcome !== undefined)) {
          return mergeTurnItems(current, params.turn, false)
        }
        let next: ThreadView = {
          ...clearError(current),
          status: 'running',
          activity: current.activity === 'pending' || current.activity === 'input' ? current.activity : 'running',
          activeTurnId: turnId || current.activeTurnId,
        }
        return mergeTurnItems(next, params.turn, true)
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
        const completedId = idValue(turn?.id) || idValue(params.turnId) || current.activeTurnId || ''
        if (completedId && !turn) next = upsertTurnMeta(next, completedId, { record: { status: turnStatus } })
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
        completed.kind === 'backgroundTask',
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
  const reason = translateMessage(scalarText(params.reason))
  return [
    command ? `$ ${command}` : '',
    cwd ? `cwd: ${cwd}` : '',
    reason ? t('原因: {reason}', { reason }) : '',
  ]
    .filter(Boolean)
    .join('\n') || t('命令需要确认')
}

function fileChangeDetail(params: JsonRecord): string {
  const fileChanges = asRecord(params.fileChanges)
  const paths = fileChanges ? Object.keys(fileChanges) : []
  const reason = translateMessage(scalarText(params.reason))
  const grantRoot = scalarText(params.grantRoot)
  return [reason, ...paths, grantRoot].filter(Boolean).join('\n') || t('文件改动需要确认')
}

function permissionsDetail(params: JsonRecord): string {
  const reason = translateMessage(scalarText(params.reason))
  const permissions = asRecord(params.permissions)
  return [reason, permissions ? safeStringify(permissions) : ''].filter(Boolean).join('\n') || t('权限需要确认')
}

function otherDetail(method: string, params: JsonRecord): string {
  const reason = translateMessage(scalarText(params.reason) || scalarText(params.message))
  return [method, reason].filter(Boolean).join('\n') || t('需要用户处理')
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
      title = t('命令执行审批')
      detail = commandDetail(params)
      break
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      kind = 'fileChange'
      title = t('文件改动审批')
      detail = fileChangeDetail(params)
      break
    case 'item/permissions/requestApproval':
      kind = 'permissions'
      title = t('权限申请')
      detail = permissionsDetail(params)
      break
    case USER_INPUT_METHOD:
      kind = 'other'
      title = t('Agent 需要你的回答')
      detail = parseUserInputQuestions(params).map((question) => question.question).join('\n') || t('需要用户处理')
      break
    case ELICITATION_METHOD:
      kind = 'other'
      title = t('MCP 服务请求')
      detail = elicitationDetail(params)
      break
    default:
      kind = 'other'
      title = t('其他请求')
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
    ...(method === USER_INPUT_METHOD ? { questions: parseUserInputQuestions(params) } : {}),
    ...(method === ELICITATION_METHOD ? elicitationView(params, detail) : {}),
  }

  return withThread(s, threadId, (thread) => {
    const pendingApprovals = [
      ...thread.pendingApprovals.filter((existing) => existing.requestId !== requestId),
      approval,
    ]
    // turnId 明确为 null 的请求（pi 扩展、MCP）可能发生在轮次之外，不能把会话改成运行中。
    if (params.turnId === null) return { ...thread, pendingApprovals }
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
  // i18n-ignore: 回给 Agent 的拒绝理由，进入模型上下文
  return { denied: { rejection: '用户拒绝该操作' } }
}

/** 问答卡片的提交结果；空对象表示用户点了跳过或拒绝。 */
export function userAnswerResponse(a: ApprovalView, answers: Readonly<Record<string, readonly string[]>>): unknown {
  return a.method === ELICITATION_METHOD ? elicitationAnswer(approvalParams(a), answers) : userInputResponse(answers)
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
    case ELICITATION_METHOD:
      // 只有可直接确认的请求接受 accept，其余一律按拒绝回复。
      return elicitationDecision(decision === 'accept' && a.decisions?.includes('accept') === true)
    default: {
      // 未知请求没有可推导的响应体，交由调用方按具体 method 处理
      return {}
    }
  }
}
