/**
 * pi RPC 会话事件 → codex app-server v2 通知的纯函数映射；
 * 同时把 get_messages 的会话历史还原成 v2 Thread/turns/items。
 * 不修改传入的 state；bridge 每轮持有一份 state。
 */
import {
  agentMessageItem,
  asRecord,
  buildThread,
  buildTurn,
  commandExecutionItem,
  deltaNotification,
  dynamicToolCallItem,
  fileChangeItem,
  finite,
  isRecord,
  itemCompleted,
  itemStarted,
  notification,
  reasoningItem,
  scalarText,
  summarizeInput,
  userMessageContentItem,
  type Json,
  type MapContext,
  type SessionMeta,
  type V2Item,
  type V2Notification,
} from '../claude/v2'
import { isSteerPlacement, type SteerPlacement } from '../steerHistory'
import { unifiedDiff } from '../claude/items'

export type JsonRecord = Json

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  reasoning: number
}

interface BlockState {
  itemId: string
  kind: 'text' | 'thinking'
  text: string
  started: boolean
  done: boolean
}

export interface MapState {
  nextItem: number
  messageIndex: number
  blocks: Record<string, BlockState>
  toolItems: Record<string, V2Item>
  items: Record<string, V2Item>
  order: string[]
  error: string | null
  totalUsage: PiUsage | null
}

export interface MapResult {
  notifications: V2Notification[]
  state: MapState
  /** agent_settled 到达时给出本轮结果，bridge 据此清空 turnId。 */
  turnEnd?: { status: string; error: string | null }
}

const BASH_TOOLS = new Set(['bash', 'powershell'])
const FILE_EDIT_TOOLS = new Set(['edit', 'write'])

export function emptyMapState(): MapState {
  return {
    nextItem: 0,
    messageIndex: 0,
    blocks: {},
    toolItems: {},
    items: {},
    order: [],
    error: null,
    totalUsage: null,
  }
}

function cloneState(state: MapState): MapState {
  const blocks: Record<string, BlockState> = {}
  for (const [key, block] of Object.entries(state.blocks)) blocks[key] = { ...block }
  return {
    nextItem: state.nextItem,
    messageIndex: state.messageIndex,
    blocks,
    toolItems: { ...state.toolItems },
    items: { ...state.items },
    order: [...state.order],
    error: state.error,
    totalUsage: state.totalUsage ? { ...state.totalUsage } : null,
  }
}

function recordItem(state: MapState, item: V2Item): void {
  const id = scalarText(item.id)
  if (!id) return
  if (!Object.hasOwn(state.items, id)) state.order.push(id)
  state.items[id] = item
}

function blockKey(state: MapState, contentIndex: number): string {
  return `${state.messageIndex}:${contentIndex}`
}

function ensureBlock(
  ctx: MapContext,
  state: MapState,
  key: string,
  kind: 'text' | 'thinking',
): string {
  const existing = state.blocks[key]
  if (existing) return existing.itemId
  const id = `${ctx.turnId || 'turn'}-item-${++state.nextItem}`
  state.blocks[key] = { itemId: id, kind, text: '', started: false, done: false }
  state.items[id] = kind === 'thinking' ? reasoningItem(id, '') : agentMessageItem(id, '')
  state.order.push(id)
  return id
}

function startBlock(
  ctx: MapContext,
  state: MapState,
  key: string,
  kind: 'text' | 'thinking',
  out: V2Notification[],
): string {
  const id = ensureBlock(ctx, state, key, kind)
  const block = state.blocks[key]
  if (block && !block.started) {
    block.started = true
    const item = state.items[id]
    if (item) out.push(itemStarted(ctx, item))
  }
  return id
}

function completeBlock(
  ctx: MapContext,
  state: MapState,
  key: string,
  kind: 'text' | 'thinking',
  text: string,
  out: V2Notification[],
): void {
  const id = startBlock(ctx, state, key, kind, out)
  const block = state.blocks[key]
  if (!block || (block.done && block.text === text)) return
  block.text = text
  block.done = true
  const item: V2Item = kind === 'thinking' ? reasoningItem(id, text) : agentMessageItem(id, text)
  recordItem(state, item)
  out.push(itemCompleted(ctx, item))
}

/** pi 的编辑工具参数形状与 Claude SDK 不同，这里按官方文档的字段名生成统一 diff。 */
export function piFileChanges(tool: string, input: unknown): Json[] {
  const args = asRecord(input) ?? {}
  const filePath = scalarText(args.path) || scalarText(args.file_path) || '(unknown)'
  const content = scalarText(args.content)
  const edits = Array.isArray(args.edits) ? args.edits : []
  const one = (before: string, after: string, kind: string): Json => ({
    path: filePath,
    kind: { type: kind, move_path: null },
    diff: unifiedDiff(filePath, before, after),
  })
  if (tool === 'write') return [one('', content, 'add')]
  if (edits.length > 0) {
    return [
      {
        path: filePath,
        kind: { type: 'update', move_path: null },
        diff: edits
          .map((entry) => {
            const edit = asRecord(entry) ?? {}
            return unifiedDiff(
              filePath,
              scalarText(edit.oldText) || scalarText(edit.old_string),
              scalarText(edit.newText) || scalarText(edit.new_string),
            )
          })
          .join('\n'),
      },
    ]
  }
  return [
    one(
      scalarText(args.oldText) || scalarText(args.old_string),
      scalarText(args.newText) || scalarText(args.new_string) || content,
      'update',
    ),
  ]
}

export function piToolItem(id: string, tool: string, input: unknown, cwd: string): V2Item {
  const args = asRecord(input) ?? {}
  if (BASH_TOOLS.has(tool)) {
    return commandExecutionItem(id, {
      command: scalarText(args.command) || `${tool} ${summarizeInput(input)}`,
      cwd: cwd,
    })
  }
  if (FILE_EDIT_TOOLS.has(tool)) return fileChangeItem(id, piFileChanges(tool, input))
  return dynamicToolCallItem(id, tool, input)
}

function ensureToolItem(
  ctx: MapContext,
  state: MapState,
  toolCallId: string,
  tool: string,
  input: unknown,
  out: V2Notification[],
): void {
  if (state.toolItems[toolCallId]) return
  const id = `${ctx.turnId || 'turn'}-tool-${++state.nextItem}`
  const item = piToolItem(id, tool, input, ctx.cwd)
  state.toolItems[toolCallId] = item
  recordItem(state, item)
  out.push(itemStarted(ctx, item))
}

function completeToolItem(
  ctx: MapContext,
  state: MapState,
  toolCallId: string,
  output: string,
  isError: boolean,
  out: V2Notification[],
): void {
  const existing = state.toolItems[toolCallId]
  if (!existing) return
  if (existing.status === 'completed' || existing.status === 'failed') return
  const item: V2Item = { ...existing }
  if (item.type === 'commandExecution') {
    item.aggregatedOutput = output
    item.exitCode = isError ? 1 : 0
  } else if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
    item.contentItems = [{ type: 'text', text: output }]
    item.success = !isError
  }
  item.status = isError ? 'failed' : 'completed'
  state.toolItems[toolCallId] = item
  recordItem(state, item)
  out.push(itemCompleted(ctx, item))
}

/** tool_execution_end.result / toolResult 消息的 content → 纯文本。 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((entry) => {
      const record = asRecord(entry)
      return record?.type === 'text' ? scalarText(record.text) : ''
    })
    .filter(Boolean)
    .join('\n')
}

function resultContent(result: unknown): unknown {
  const record = asRecord(result)
  return record ? record.content : undefined
}

export function addUsage(total: PiUsage | null, raw: unknown): PiUsage | null {
  const usage = asRecord(raw)
  if (!usage) return total
  const cost = asRecord(usage.cost)
  const part: PiUsage = {
    input: finite(usage.input) ?? 0,
    output: finite(usage.output) ?? 0,
    cacheRead: finite(usage.cacheRead) ?? 0,
    cacheWrite: finite(usage.cacheWrite) ?? 0,
    totalTokens: finite(usage.totalTokens) ?? 0,
    cost: finite(cost?.total) ?? 0,
    reasoning: finite(usage.reasoning) ?? 0,
  }
  if (!total) return part
  return {
    input: total.input + part.input,
    output: total.output + part.output,
    cacheRead: total.cacheRead + part.cacheRead,
    cacheWrite: total.cacheWrite + part.cacheWrite,
    totalTokens: total.totalTokens + part.totalTokens,
    cost: total.cost + part.cost,
    reasoning: total.reasoning + part.reasoning,
  }
}

export function piTokenUsage(usage: PiUsage): Json {
  const breakdown = {
    totalTokens: usage.totalTokens,
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    cachedInputTokens: usage.cacheRead,
    cacheWriteInputTokens: usage.cacheWrite,
    outputTokens: usage.output,
    reasoningOutputTokens: usage.reasoning,
  }
  return {
    total: breakdown,
    last: breakdown,
    modelContextWindow: null,
    estimatedCostUsd: usage.cost,
    estimated: true,
  }
}

/** 仍在 inProgress 的 item 在轮次结束时补 completed，避免界面一直显示运行中。 */
export function finishPendingItems(ctx: MapContext, state: MapState, failed = false): V2Notification[] {
  const out: V2Notification[] = []
  for (const id of state.order) {
    const item = state.items[id]
    if (!isRecord(item) || item.status !== 'inProgress') continue
    const completed: V2Item = { ...item, status: failed ? 'failed' : 'completed' }
    if (completed.type === 'commandExecution' && completed.exitCode === null) {
      completed.exitCode = failed ? 1 : 0
    }
    state.items[id] = completed
    out.push(itemCompleted(ctx, completed))
  }
  return out
}

/**
 * get_session_stats 的 contextUsage → tokenUsage。压缩刚结束时 pi 给 null，此时返回 null 不覆盖现有读数。
 * 与 Claude 一致：last 表示当前上下文占用，客户端据此与窗口相除。
 */
export function piContextTokenUsage(context: unknown, total: PiUsage | null): Json | null {
  const data = asRecord(context)
  const tokens = finite(data?.tokens)
  const window = finite(data?.contextWindow)
  if (tokens === null || tokens < 0 || window === null || window <= 0) return null
  const base: Json = total ? piTokenUsage(total) : { estimated: true }
  const last = { ...(asRecord(base.last) ?? {}), totalTokens: tokens }
  return { ...base, total: base.total ?? last, last, modelContextWindow: window }
}

/** turn 结束通知（turn/completed + tokenUsage）由纯函数生成，实时流与异常兜底共用。 */
export function finishTurnNotifications(
  ctx: MapContext,
  state: MapState,
  status: string,
  error: string | null,
): V2Notification[] {
  const out = finishPendingItems(ctx, state, status === 'failed')
  const items = state.order.map((id) => state.items[id]).filter(isRecord)
  out.push(
    notification('turn/completed', {
      threadId: ctx.threadId,
      turn: buildTurn(ctx.turnId, items, status, error),
    }),
  )
  if (state.totalUsage && state.totalUsage.totalTokens > 0) {
    out.push(
      notification('thread/tokenUsage/updated', {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        tokenUsage: piTokenUsage(state.totalUsage),
      }),
    )
  }
  return out
}

function mapMessageUpdate(
  msg: Json,
  ctx: MapContext,
  state: MapState,
  out: V2Notification[],
): void {
  const event = asRecord(msg.assistantMessageEvent)
  if (!event) return
  const index = finite(event.contentIndex) ?? 0
  const key = blockKey(state, index)
  switch (event.type) {
    case 'text_start':
      startBlock(ctx, state, key, 'text', out)
      return
    case 'text_delta': {
      const id = startBlock(ctx, state, key, 'text', out)
      const delta = scalarText(event.delta)
      if (!delta) return
      const block = state.blocks[key]
      if (block) block.text += delta
      out.push(deltaNotification('item/agentMessage/delta', ctx, id, delta))
      return
    }
    case 'text_end':
      completeBlock(ctx, state, key, 'text', scalarText(event.content), out)
      return
    case 'thinking_start':
      startBlock(ctx, state, key, 'thinking', out)
      return
    case 'thinking_delta': {
      const id = startBlock(ctx, state, key, 'thinking', out)
      const delta = scalarText(event.delta)
      if (!delta) return
      const block = state.blocks[key]
      if (block) block.text += delta
      out.push(
        deltaNotification('item/reasoning/summaryTextDelta', ctx, id, delta, { summaryIndex: 0 }),
      )
      return
    }
    case 'thinking_end':
      completeBlock(ctx, state, key, 'thinking', scalarText(event.content), out)
      return
    case 'toolcall_start':
      // 参数还没收齐；toolcall_end / tool_execution_start 才建 item。
      return
    case 'toolcall_end': {
      const call = asRecord(event.toolCall)
      const toolCallId = scalarText(call?.id) || scalarText(event.id) || `${key}-tool`
      const tool = scalarText(call?.name) || scalarText(event.toolName) || 'tool'
      ensureToolItem(ctx, state, toolCallId, tool, call?.arguments ?? {}, out)
      return
    }
    case 'error': {
      const info = asRecord(event.error)
      state.error = scalarText(info?.errorMessage) || scalarText(event.reason) || 'pi provider 流错误'
      return
    }
    default:
      return
  }
}

function mapMessageEnd(msg: Json, ctx: MapContext, state: MapState, out: V2Notification[]): void {
  const message = asRecord(msg.message)
  if (!message) return
  const role = scalarText(message.role)
  if (role === 'assistant') {
    const blocks = Array.isArray(message.content) ? message.content : []
    for (let index = 0; index < blocks.length; index++) {
      const block = asRecord(blocks[index])
      if (!block) continue
      const key = blockKey(state, index)
      const type = scalarText(block.type)
      if (type === 'text' || type === 'thinking') {
        const kind = type === 'thinking' ? 'thinking' : 'text'
        completeBlock(ctx, state, key, kind, scalarText(block[type]), out)
      } else if (type === 'toolCall') {
        const toolCallId = scalarText(block.id) || `${key}-tool`
        ensureToolItem(ctx, state, toolCallId, scalarText(block.name) || 'tool', block.arguments ?? {}, out)
      }
    }
    state.totalUsage = addUsage(state.totalUsage, message.usage)
    if (message.stopReason === 'error' || message.errorMessage) {
      state.error = scalarText(message.errorMessage) || 'pi assistant 消息出错'
    }
    return
  }
  if (role === 'toolResult') {
    completeToolItem(
      ctx,
      state,
      scalarText(message.toolCallId),
      contentText(message.content),
      message.isError === true,
      out,
    )
  }
}

/** 一条真实 pi 事件 → v2 通知；未知事件类型忽略，不猜测语义。 */
export function mapPiEvent(event: unknown, ctx: MapContext, inputState: MapState): MapResult {
  const state = cloneState(inputState)
  const out: V2Notification[] = []
  const msg = asRecord(event)
  if (!msg) return { notifications: out, state }
  switch (msg.type) {
    case 'message_start':
      state.messageIndex += 1
      return { notifications: out, state }
    case 'message_update':
      mapMessageUpdate(msg, ctx, state, out)
      break
    case 'message_end':
      mapMessageEnd(msg, ctx, state, out)
      break
    case 'tool_execution_start': {
      const args = msg.args ?? {}
      ensureToolItem(ctx, state, scalarText(msg.toolCallId), scalarText(msg.toolName), args, out)
      break
    }
    case 'tool_execution_end': {
      completeToolItem(
        ctx,
        state,
        scalarText(msg.toolCallId),
        contentText(resultContent(msg.result)),
        msg.isError === true,
        out,
      )
      break
    }
    case 'turn_end': {
      // tool_execution_end 缺失时用 turn_end 的 toolResults 兜底完成 tool item。
      const results = Array.isArray(msg.toolResults) ? msg.toolResults : []
      for (const raw of results) {
        const toolResult = asRecord(raw)
        if (!toolResult) continue
        completeToolItem(
          ctx,
          state,
          scalarText(toolResult.toolCallId),
          contentText(toolResult.content),
          toolResult.isError === true,
          out,
        )
      }
      break
    }
    case 'agent_settled': {
      const aborted = msg.aborted === true
      const status = aborted ? 'interrupted' : state.error ? 'failed' : 'completed'
      out.push(...finishTurnNotifications(ctx, state, status, aborted ? null : state.error))
      return { notifications: out, state, turnEnd: { status, error: aborted ? null : state.error } }
    }
    case 'auto_retry_end':
      if (msg.success === false) state.error = scalarText(msg.finalError) || 'pi 重试失败'
      break
    case 'extension_error':
      state.error = scalarText(msg.error) || 'pi 扩展异常'
      break
    default:
      break
  }
  return { notifications: out, state }
}

/** pi 会话线程：字段名补齐为 v2，但归属标为 pi，不冒充 codex/claude。 */
/** config 为会话最近一次的模型（provider/id）与思考档位，供客户端恢复该会话的选择。 */
export function piThread(
  meta: SessionMeta,
  turns: Json[] = [],
  config: { model: string | null; thinkingLevel: string | null } = { model: null, thinkingLevel: null },
): Json {
  return {
    ...buildThread(meta, turns),
    modelProvider: 'pi',
    cliVersion: 'pi-rpc',
    source: { custom: 'pi-rpc' },
    model: config.model,
    reasoningEffort: config.thinkingLevel,
  }
}

function userEcho(content: unknown): Json[] {
  const out: Json[] = []
  if (typeof content === 'string') {
    if (content.trim()) out.push({ type: 'text', text: content, text_elements: [] })
    return out
  }
  if (!Array.isArray(content)) return out
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === 'text' && scalarText(block.text)) {
      out.push({ type: 'text', text: scalarText(block.text), text_elements: [] })
    } else if (block.type === 'image') {
      const mimeType = scalarText(block.mimeType) || 'image/png'
      out.push({ type: 'image', url: `data:${mimeType};base64,${scalarText(block.data)}` })
    }
  }
  return out
}

export interface HistoryResult {
  thread: Json
  turns: Json[]
  items: V2Item[]
}

export type UserMessageIdentity = { id: string; clientId: string | null; steering?: SteerPlacement }

export function parsePiSteer(value: unknown): UserMessageIdentity | undefined {
  const entry = asRecord(value)
  if (isSteerPlacement(entry?.steering) && typeof entry.id === 'string') {
    return { id: entry.id, clientId: scalarText(entry.clientId) || null, steering: entry.steering }
  }
}

/** get_messages 的完整历史 → v2 thread；按带文本或图片的用户消息切分 turns。 */
export function messagesToThread(
  meta: SessionMeta,
  messages: unknown[],
  userItemIds?: ReadonlyMap<string, UserMessageIdentity | null>,
): HistoryResult {
  const state = emptyMapState()
  const open: { id: string; itemIds: string[]; error?: string }[] = []
  let current: { id: string; itemIds: string[]; error?: string } | null = null
  const ctxFor = (turnId: string): MapContext => ({
    threadId: meta.id,
    turnId,
    cwd: meta.cwd,
  })
  const uniqueUserIds = new Map<string, UserMessageIdentity | null>()
  if (userItemIds?.size) {
    for (const raw of messages) {
      const message = asRecord(raw)
      if (message?.role !== 'user') continue
      const timestamp = finite(message.timestamp)
      if (timestamp === null) continue
      const key = String(timestamp)
      const identity = userItemIds.get(key)
      // 时间戳相同的原生消息会各自保留，避免把两次发送合成一条。
      if (identity) uniqueUserIds.set(key, uniqueUserIds.has(key) ? null : identity)
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = asRecord(messages[index])
    if (!message) continue
    const role = scalarText(message.role)
    // 系统消息、bashExecution 等非 v2 展示角色跳过。
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') continue
    const echo = role === 'user' ? userEcho(message.content) : []
    if (role === 'user' && echo.length === 0) continue
    const timestamp = role === 'user' ? finite(message.timestamp) : null
    const identity = timestamp === null ? null : uniqueUserIds.get(String(timestamp))
    if (!current || (role === 'user' && !identity?.steering)) {
      current = { id: `turn-${meta.id}-${index}`, itemIds: [] }
      open.push(current)
    }
    const ctx = ctxFor(current.id)
    const before = state.order.length
    if (role === 'user') {
      const item = userMessageContentItem(identity?.id ?? `${current.id}-user`, echo, identity?.clientId)
      if (identity?.steering) item.steering = identity.steering
      recordItem(state, item)
      current.itemIds.push(scalarText(item.id))
      continue
    }
    if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        const block = asRecord(blocks[blockIndex])
        if (!block) continue
        const type = scalarText(block.type)
        const id = `${current.id}-item-${++state.nextItem}`
        let item: V2Item | null = null
        if (type === 'text') item = agentMessageItem(id, scalarText(block.text))
        else if (type === 'thinking') item = reasoningItem(id, scalarText(block.thinking))
        else if (type === 'toolCall') {
          const toolCallId = scalarText(block.id) || `${current.id}-tool-${blockIndex}`
          item = piToolItem(id, scalarText(block.name) || 'tool', block.arguments ?? {}, meta.cwd)
          state.toolItems[toolCallId] = item
        }
        if (item) {
          recordItem(state, item)
          current.itemIds.push(id)
        }
      }
      state.totalUsage = addUsage(state.totalUsage, message.usage)
      // 出错的回复（如上游 429）没有内容块；不记下原因的话历史里只剩用户消息，看不出发生了什么。
      // pi 自动重试成功后以最后一条为准。
      if (message.stopReason === 'error' || message.errorMessage) {
        current.error = scalarText(message.errorMessage) || 'pi assistant 消息出错'
      } else {
        delete current.error
      }
      continue
    }
    // toolResult：把对应 tool item 标为完成，不再额外产生 item。
    const toolCallId = scalarText(message.toolCallId)
    const existing = state.toolItems[toolCallId]
    if (existing) {
      const completed: V2Item = { ...existing, status: message.isError === true ? 'failed' : 'completed' }
      if (completed.type === 'commandExecution') {
        completed.aggregatedOutput = contentText(message.content)
        completed.exitCode = message.isError === true ? 1 : 0
      }
      state.toolItems[toolCallId] = completed
      recordItem(state, completed)
    }
    for (const id of state.order.slice(before)) current.itemIds.push(id)
  }

  const turns: Json[] = open.map((turn) =>
    buildTurn(
      turn.id,
      turn.itemIds.map((id) => state.items[id]).filter(isRecord),
      turn.error ? 'failed' : 'completed',
      turn.error ?? null,
      'history',
    ),
  )
  const items = state.order.map((id) => state.items[id]).filter(isRecord)
  return { thread: piThread(meta, turns), turns, items }
}

/** 无历史时的最小线程（未知 threadId 的 thread/read 兜底）。 */
export function emptyThread(meta: SessionMeta): Json {
  return piThread(meta)
}
