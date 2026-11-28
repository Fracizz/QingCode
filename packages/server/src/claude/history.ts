/** getSessionMessages / listSessions 的历史 → v2 Thread/turns/items（纯函数）。 */
import { emptyMapState, mapHistoryMessage } from './items'
import { isForkNotice, peerMessage } from './injected'
import { parseLocalCommand } from './localCommand'
import { userTaskNotification } from './taskNotification'
import type { PlanStep, PlanTracker } from './plan'
import type { ThreadStatus } from '../../../../vendor/codex-protocol/ts/v2/ThreadStatus'
import { isSteerPlacement, type SteerPlacement } from '../steerHistory'
import {
  asRecord,
  buildThread,
  buildTurn,
  finite,
  isRecord,
  scalarText,
  type Json,
  type MapContext,
  type SessionMeta,
  type ThreadConfig,
  type V2Item,
  tokenBreakdown,
} from './v2'

export interface HistoryResult {
  thread: Json
  turns: Json[]
  items: V2Item[]
  /** promptMessageId 是开启该轮的用户消息，由系统记录开启的轮次没有。 */
  forkPoints: { turnId: string; firstMessageId: string; lastMessageId: string; promptMessageId?: string }[]
  /** 读完历史后的任务清单，用于让续用的会话认得已有任务。 */
  plan: PlanTracker
}

export type ClaudeSteerHistory = { placement: SteerPlacement; startsTurn: boolean }

export function parseClaudeSteer(value: unknown): ClaudeSteerHistory | undefined {
  const entry = asRecord(value)
  if (isSteerPlacement(entry?.placement) && typeof entry.startsTurn === 'boolean') {
    return { placement: entry.placement, startsTurn: entry.startsTurn }
  }
}

/** SDKSessionInfo 的时间戳是毫秒，v2 Thread 用秒。 */
export function msToSeconds(value: unknown): number | undefined {
  const num = finite(value)
  return num === null ? undefined : Math.floor(num / 1000)
}

export function sessionInfoToMeta(info: unknown, fallbackCwd: string): SessionMeta {
  const record = asRecord(info) ?? {}
  return {
    id: scalarText(record.sessionId),
    cwd: scalarText(record.cwd) || fallbackCwd,
    preview: scalarText(record.summary) || scalarText(record.firstPrompt),
    ...(typeof record.customTitle === 'string' ? { name: record.customTitle } : {}),
    ...(msToSeconds(record.createdAt) !== undefined
      ? { createdAt: msToSeconds(record.createdAt) }
      : {}),
    ...(msToSeconds(record.lastModified) !== undefined
      ? { updatedAt: msToSeconds(record.lastModified) }
      : {}),
  }
}

export function threadListResponse(sessions: SessionMeta[], limit?: number, statusFor?: (id: string) => ThreadStatus): Json {
  const data = sessions
    .filter((meta) => meta.id.length > 0)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limit)
    .map((meta) => statusFor ? { ...buildThread(meta), status: statusFor(meta.id) } : buildThread(meta))
  return { data, nextCursor: null, backwardsCursor: null }
}

function hasUserText(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((entry) => {
    const record = asRecord(entry)
    if (record?.type === 'image') return true
    return record?.type === 'text' && scalarText(record.text).length > 0
  })
}

const INTERRUPT_MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])

/** Claude Code 中断时以 user 身份写入固定正文的占位记录，SDK 历史接口只能按正文识别。 */
function isInterruptMarker(message: Record<string, unknown>): boolean {
  if (message.role !== 'user') return false
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  return blocks.length > 0 && blocks.every((block) =>
    INTERRUPT_MARKERS.has(typeof block === 'string' ? block : scalarText(asRecord(block)?.text)))
}

interface OpenTurn {
  id: string
  itemIds: string[]
  interrupted?: boolean
  error?: string
  firstMessageId: string
  lastMessageId: string
  promptMessageId?: string
  plan?: PlanStep[]
}

/**
 * Claude Code 在 API 失败时写入一条 model 为 `<synthetic>`、正文以 `API Error` 开头的 assistant 消息，
 * 历史里没有其它失败标记；据此把该轮标为 failed，与实时失败时的展示一致。
 */
function syntheticApiError(message: Record<string, unknown>): string | undefined {
  if (message.role !== 'assistant' || message.model !== '<synthetic>') return undefined
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  const text = blocks
    .map((block) => (typeof block === 'string' ? block : scalarText(asRecord(block)?.text)))
    .join('')
    .trim()
  return text.startsWith('API Error') ? text : undefined
}

/**
 * 会话最近一次回复实际用的模型：从后往前找主会话的 assistant 消息。
 * 跳过子 agent（parent_tool_use_id / isSidechain）和 API 失败时写入的 `<synthetic>` 占位消息。
 * 推理强度 SDK 历史接口不提供，不在这里猜。
 */
export function lastReplyModel(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = asRecord(messages[index])
    if (!entry || entry.isSidechain === true || scalarText(entry.parent_tool_use_id)) continue
    const message = asRecord(entry.message ?? messages[index])
    if (!message || scalarText(message.role) !== 'assistant') continue
    const model = scalarText(message.model)
    if (model && model !== '<synthetic>') return model
  }
  return null
}

/**
 * 历史里最近一次主代理回复的 usage 就是会话当前的上下文占用，打开历史会话时据此补上占用环。
 * 之后若发生过压缩，压缩前的读数已失效，返回 null 等下一轮上报。
 */
export function lastContextUsage(messages: unknown[]): (Json & { totalTokens: number }) | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const entry = asRecord(messages[index])
    if (!entry || entry.isSidechain === true || scalarText(entry.parent_tool_use_id)) continue
    if (entry.isCompactSummary === true || scalarText(entry.subtype) === 'compact_boundary') return null
    const message = asRecord(entry.message ?? messages[index])
    if (!message || scalarText(message.role) !== 'assistant' || scalarText(message.model) === '<synthetic>') continue
    const usage = asRecord(message.usage)
    if (!usage) continue
    const last = tokenBreakdown(usage)
    if (last.totalTokens > 0) return last
  }
  return null
}

/**
 * 按用户输入切分 turns，后台任务通知、工具回执与回复都归属当前 turn。
 */
export function sessionMessagesToThread(
  meta: SessionMeta,
  messages: unknown[],
  config: ThreadConfig = {},
  taskDeliveryIds?: ReadonlyMap<string, string>,
  steers?: ReadonlyMap<string, ClaudeSteerHistory>,
): HistoryResult {
  const state = emptyMapState()
  const open: OpenTurn[] = []
  let current: OpenTurn | null = null

  for (let index = 0; index < messages.length; index++) {
    const entry = asRecord(messages[index])
    const raw = entry?.message ?? messages[index]
    let apiMessage = asRecord(raw)
    if (!apiMessage) continue
    let role = scalarText(apiMessage.role)
    const messageId = scalarText(entry?.uuid)
    const parentToolUseId = scalarText(entry?.parent_tool_use_id)
    if (parentToolUseId) {
      // 子代理内部消息不开启轮次，也不进主对话。
      if (current) {
        mapHistoryMessage({ type: role === 'assistant' ? 'assistant' : 'user', message: apiMessage,
          parent_tool_use_id: parentToolUseId }, { threadId: meta.id, turnId: current.id, cwd: meta.cwd }, state)
      }
      continue
    }
    if (isInterruptMarker(apiMessage)) {
      // 不是用户输入：只记录当前轮次被中断，分叉边界仍包含这条记录。
      if (current) {
        current.interrupted = true
        if (messageId) current.lastMessageId = messageId
      }
      continue
    }
    // 终端里执行的本地斜杠命令：命令显示为用户输入，输出作为该轮的回复，说明性记录直接略过。
    const local = role === 'user' ? parseLocalCommand(apiMessage.content) : undefined
    if (local?.kind === 'skip') continue
    if (local?.kind === 'command') apiMessage = { ...apiMessage, content: local.text }
    if (local?.kind === 'output') {
      // 输出不是新的用户输入，改按回复处理，留在命令所在的轮次里。
      role = 'assistant'
      apiMessage = { role, id: messageId, content: [{ type: 'text', text: local.text }] }
    }
    const steer = steers?.get(messageId)
    // SDK 的 assistant/user 包装类型与 Anthropic API 的 message 对象不同，这里补一层。
    const sdkMessage: Json = {
      type: role === 'assistant' ? 'assistant' : 'user',
      message: apiMessage,
      uuid: entry?.uuid,
      origin: entry?.origin,
      isCompactSummary: entry?.isCompactSummary,
    }
    if (isForkNotice(sdkMessage)) continue
    const injected = Boolean(userTaskNotification(sdkMessage) || peerMessage(sdkMessage) || sdkMessage.isCompactSummary)
    const prompt = role === 'user' && hasUserText(apiMessage.content) && !injected
    // 中断之后系统又写入通知或消息时另起一轮，中断提示留在原处。
    if (!current || (current.interrupted && injected) || (prompt && (steer?.startsTurn ?? true))) {
      current = { id: `turn-${meta.id}-${index}`, itemIds: [], firstMessageId: messageId, lastMessageId: '',
        ...(prompt && messageId ? { promptMessageId: messageId } : {}) }
      open.push(current)
    }
    if ((role === 'user' || role === 'assistant') && messageId) current.lastMessageId = messageId
    const ctx: MapContext = { threadId: meta.id, turnId: current.id, cwd: meta.cwd }
    const before = state.order.length
    if (role === 'assistant') {
      const apiError = syntheticApiError(apiMessage)
      if (apiError) current.error = apiError
      else delete current.error
    }
    for (const note of mapHistoryMessage(sdkMessage, ctx, state, taskDeliveryIds)) {
      if (note.method === 'turn/plan/updated') current.plan = note.params.plan as PlanStep[]
    }
    const item = state.items[messageId]
    if (steer && item?.type === 'userMessage') item.steering = steer.placement
    for (const id of state.order.slice(before)) current.itemIds.push(id)
  }
  // item 的 completed 状态可能在后续消息里才补齐，turn 对象必须最后一次性生成。
  const finalTurns: Json[] = open.map((turn) => {
    const built = buildTurn(
      turn.id,
      turn.itemIds.map((id) => state.items[id]).filter(isRecord),
      turn.interrupted ? 'interrupted' : turn.error ? 'failed' : 'completed',
      turn.error ?? null,
      'history',
    )
    // 与实时的 turn/plan/updated 同样的内容，挂在清单发生变化的轮次上。
    return turn.plan ? { ...built, plan: { explanation: null, plan: turn.plan } } : built
  })
  const items = state.order.map((id) => state.items[id]).filter(isRecord)
  const forkPoints = open.map(({ id: turnId, firstMessageId, lastMessageId, promptMessageId }) => (
    { turnId, firstMessageId, lastMessageId, ...(promptMessageId ? { promptMessageId } : {}) }))
  return { thread: buildThread(meta, finalTurns, config), turns: finalTurns, items, forkPoints, plan: state.plan }
}
