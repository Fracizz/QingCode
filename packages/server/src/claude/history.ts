/** getSessionMessages / listSessions 的历史 → v2 Thread/turns/items（纯函数）。 */
import { emptyMapState, mapHistoryMessage } from './items'
import type { ThreadStatus } from '../../../../vendor/codex-protocol/ts/v2/ThreadStatus'
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
} from './v2'

export interface HistoryResult {
  thread: Json
  turns: Json[]
  items: V2Item[]
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

interface OpenTurn {
  id: string
  itemIds: string[]
  error?: string
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
 * 按用户消息切分 turns：每条带文本的用户消息开启新 turn，
 * tool_result 与 assistant 消息归属当前 turn；item 映射复用 items.ts。
 */
export function sessionMessagesToThread(
  meta: SessionMeta,
  messages: unknown[],
  config: ThreadConfig = {},
): HistoryResult {
  const state = emptyMapState()
  const open: OpenTurn[] = []
  let current: OpenTurn | null = null

  for (let index = 0; index < messages.length; index++) {
    const entry = asRecord(messages[index])
    const raw = entry?.message ?? messages[index]
    const apiMessage = asRecord(raw)
    if (!apiMessage) continue
    const role = scalarText(apiMessage.role)
    if (role === 'user' && hasUserText(apiMessage.content)) {
      current = { id: `turn-${meta.id}-${index}`, itemIds: [] }
      open.push(current)
    }
    if (!current) {
      current = { id: `turn-${meta.id}-${index}`, itemIds: [] }
      open.push(current)
    }
    // SDK 的 assistant/user 包装类型与 Anthropic API 的 message 对象不同，这里补一层。
    const sdkMessage: Json = {
      type: role === 'assistant' ? 'assistant' : 'user',
      message: apiMessage,
    }
    const ctx: MapContext = { threadId: meta.id, turnId: current.id, cwd: meta.cwd }
    const before = state.order.length
    if (role === 'assistant') {
      const apiError = syntheticApiError(apiMessage)
      if (apiError) current.error = apiError
      else delete current.error
    }
    mapHistoryMessage(sdkMessage, ctx, state)
    for (const id of state.order.slice(before)) current.itemIds.push(id)
  }
  // item 的 completed 状态可能在后续消息里才补齐，turn 对象必须最后一次性生成。
  const finalTurns: Json[] = open.map((turn) =>
    buildTurn(
      turn.id,
      turn.itemIds.map((id) => state.items[id]).filter(isRecord),
      turn.error ? 'failed' : 'completed',
      turn.error ?? null,
    ),
  )
  const items = state.order.map((id) => state.items[id]).filter(isRecord)
  return { thread: buildThread(meta, finalTurns, config), turns: finalTurns, items }
}
