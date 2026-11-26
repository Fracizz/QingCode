/** getSessionMessages / listSessions 的历史 → v2 Thread/turns/items（纯函数）。 */
import { emptyMapState, mapSdkMessage } from './items'
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

export function threadListResponse(infos: unknown[], fallbackCwd: string): Json {
  const data = infos
    .map((info) => sessionInfoToMeta(info, fallbackCwd))
    .filter((meta) => meta.id.length > 0)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((meta) => buildThread(meta))
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
}

/**
 * 按用户消息切分 turns：每条带文本的用户消息开启新 turn，
 * tool_result 与 assistant 消息归属当前 turn；item 映射复用 items.ts。
 */
export function sessionMessagesToThread(meta: SessionMeta, messages: unknown[]): HistoryResult {
  let state = emptyMapState()
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
    const mapped = mapSdkMessage(sdkMessage, ctx, state, { includeUserText: true })
    state = mapped.state
    for (const id of state.order.slice(before)) current.itemIds.push(id)
  }
  // item 的 completed 状态可能在后续消息里才补齐，turn 对象必须最后一次性生成。
  const finalTurns: Json[] = open.map((turn) =>
    buildTurn(turn.id, turn.itemIds.map((id) => state.items[id]).filter(isRecord), 'completed'),
  )
  const items = state.order.map((id) => state.items[id]).filter(isRecord)
  return { thread: buildThread(meta, finalTurns), turns: finalTurns, items }
}
