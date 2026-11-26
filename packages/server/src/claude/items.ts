/**
 * SDK 消息 → codex app-server v2 item/通知的纯函数映射。
 * 输入 state 不被修改，返回新的 state；bridge 按轮次持有 state，history 复用同一套映射。
 */
import {
  agentMessageItem,
  asRecord,
  commandExecutionItem,
  deltaNotification,
  dynamicToolCallItem,
  fileChangeItem,
  finite,
  isRecord,
  itemCompleted,
  itemStarted,
  mcpToolCallItem,
  notification,
  rateLimitSnapshot,
  reasoningItem,
  scalarText,
  summarizeInput,
  tokenUsage,
  userMessageItem,
  userMessageContentItem,
  buildTurn,
  type Json,
  type MapContext,
  type V2Item,
  type V2Notification,
} from './v2'
import { imageBlockToEcho } from './userInput'

export interface MapState {
  nextItem: number
  messageId: string | null
  blockIds: Record<string, string>
  blockText: Record<string, string>
  blockKinds: Record<string, string>
  toolItems: Record<string, V2Item>
  items: Record<string, V2Item>
  order: string[]
  /**
   * 文本/思考块已发出的通知阶段。流式 content_block_* 与完整 assistant 消息会描述同一个块，
   * 且二者先后不定（SDK 常先给完整消息再给 content_block_stop），据此保证 started/completed 各一次。
   */
  blockPhase?: Record<string, 'started' | 'done'>
}

export interface MapResult {
  notifications: V2Notification[]
  state: MapState
}

export interface MapOptions {
  /** 历史回放需要把用户文本转 userMessage；实时流由 bridge 在 turn/start 时自行生成。 */
  includeUserText?: boolean
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const BASH_TOOLS = new Set(['Bash', 'PowerShell'])

export function emptyMapState(): MapState {
  return {
    nextItem: 0,
    messageId: null,
    blockIds: {},
    blockText: {},
    blockKinds: {},
    toolItems: {},
    items: {},
    order: [],
  }
}

function cloneState(state: MapState): MapState {
  return {
    nextItem: state.nextItem,
    messageId: state.messageId,
    blockIds: { ...state.blockIds },
    blockText: { ...state.blockText },
    blockKinds: { ...state.blockKinds },
    toolItems: { ...state.toolItems },
    items: { ...state.items },
    order: [...state.order],
    ...(state.blockPhase ? { blockPhase: { ...state.blockPhase } } : {}),
  }
}

export function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name)
}

export function isBashTool(name: string): boolean {
  return BASH_TOOLS.has(name)
}

/** 由工具参数生成统一 diff 文本；SDK 只给 old/new 字符串，无法给出真实行号。 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before ? before.split('\n') : []
  const newLines = after ? after.split('\n') : []
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

export function fileChangesFromTool(name: string, input: unknown): Json[] {
  const record = asRecord(input) ?? {}
  const path = scalarText(record.file_path) || scalarText(record.notebook_path) || '(unknown)'
  const kind: Json = { type: 'update', move_path: null }
  if (name === 'Write') {
    return [
      {
        path,
        kind: { type: 'add' },
        diff: unifiedDiff(path, '', scalarText(record.content)),
      },
    ]
  }
  if (name === 'Edit') {
    return [
      {
        path,
        kind,
        diff: unifiedDiff(path, scalarText(record.old_string), scalarText(record.new_string)),
      },
    ]
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(record.edits) ? record.edits : []
    const diff = edits
      .map((entry) => {
        const edit = asRecord(entry) ?? {}
        return unifiedDiff(path, scalarText(edit.old_string), scalarText(edit.new_string))
      })
      .join('\n')
    return [{ path, kind, diff }]
  }
  if (name === 'NotebookEdit') {
    return [
      {
        path,
        kind,
        diff: unifiedDiff(path, scalarText(record.old_source), scalarText(record.new_source)),
      },
    ]
  }
  return []
}

export function toolUseItem(
  id: string,
  name: string,
  input: unknown,
  cwd: string,
): V2Item {
  if (isBashTool(name)) {
    const record = asRecord(input) ?? {}
    return commandExecutionItem(id, {
      command: scalarText(record.command) || `${name} ${summarizeInput(input)}`,
      cwd: scalarText(record.cwd) || cwd,
    })
  }
  if (isFileEditTool(name)) {
    return fileChangeItem(id, fileChangesFromTool(name, input))
  }
  if (name.startsWith('mcp__')) return mcpToolCallItem(id, name, input)
  return dynamicToolCallItem(id, name, input)
}

function blockKey(messageId: string | null, index: number): string {
  return `${messageId ?? 'stream'}:${index}`
}

function ensureBlockItem(
  ctx: MapContext,
  key: string,
  kind: string,
  state: MapState,
): string {
  const existing = state.blockIds[key]
  if (existing) {
    state.blockKinds[existing] = kind
    return existing
  }
  const id = `${ctx.turnId || 'turn'}-item-${++state.nextItem}`
  state.blockIds[key] = id
  state.blockKinds[id] = kind
  state.blockText[id] = ''
  const item = kind === 'thinking' ? reasoningItem(id, '') : agentMessageItem(id, '')
  state.items[id] = item
  state.order.push(id)
  return id
}

function newItemId(ctx: MapContext, state: MapState, kind: string): string {
  return `${ctx.turnId || 'turn'}-${kind}-${++state.nextItem}`
}

function recordItem(state: MapState, item: V2Item): void {
  const id = scalarText(item.id)
  if (!id) return
  state.items[id] = item
  if (!state.order.includes(id)) state.order.push(id)
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

function mapStreamEvent(message: Json, ctx: MapContext, state: MapState, out: V2Notification[]): void {
  const event = asRecord(message.event)
  if (!event) return
  switch (event.type) {
    case 'message_start': {
      state.messageId = scalarText(asRecord(event.message)?.id) || null
      return
    }
    case 'content_block_start': {
      const index = finite(event.index) ?? 0
      const block = asRecord(event.content_block)
      const kind = scalarText(block?.type)
      if (kind !== 'text' && kind !== 'thinking') return
      const id = ensureBlockItem(ctx, blockKey(state.messageId, index), kind, state)
      if (state.blockPhase?.[id]) return
      state.blockPhase = { ...(state.blockPhase ?? {}), [id]: 'started' }
      // 增量通知会自行创建 item，但显式 started 让界面在首个 delta 前就能显示气泡。
      out.push(itemStarted(ctx, state.items[id] as V2Item))
      return
    }
    case 'content_block_delta': {
      const index = finite(event.index) ?? 0
      const delta = asRecord(event.delta)
      const kind = scalarText(delta?.type)
      if (kind !== 'text_delta' && kind !== 'thinking_delta') return
      const text = scalarText(kind === 'text_delta' ? delta?.text : delta?.thinking)
      if (!text) return
      const itemKind = kind === 'text_delta' ? 'text' : 'thinking'
      const id = ensureBlockItem(ctx, blockKey(state.messageId, index), itemKind, state)
      state.blockText[id] = (state.blockText[id] ?? '') + text
      if (kind === 'text_delta') {
        out.push(deltaNotification('item/agentMessage/delta', ctx, id, text))
      } else {
        out.push(
          deltaNotification('item/reasoning/summaryTextDelta', ctx, id, text, { summaryIndex: 0 }),
        )
      }
      return
    }
    case 'content_block_stop': {
      const index = finite(event.index) ?? 0
      const id = state.blockIds[blockKey(state.messageId, index)]
      if (!id || state.blockPhase?.[id] === 'done') return
      const text = state.blockText[id] ?? ''
      const item =
        state.blockKinds[id] === 'thinking' ? reasoningItem(id, text) : agentMessageItem(id, text)
      recordItem(state, item)
      state.blockPhase = { ...(state.blockPhase ?? {}), [id]: 'done' }
      out.push(itemCompleted(ctx, item))
      return
    }
    default:
      return
  }
}

/** 完整消息里的块：未通知过 → started+completed；流式已 started → 只补 completed；已 done 且文本一致 → 不再通知。 */
function emitFinalBlock(
  ctx: MapContext,
  state: MapState,
  id: string,
  item: V2Item,
  text: string,
  out: V2Notification[],
): void {
  const phase = state.blockPhase?.[id]
  const unchanged = phase === 'done' && state.blockText[id] === text
  state.blockText[id] = text
  recordItem(state, item)
  state.blockPhase = { ...(state.blockPhase ?? {}), [id]: 'done' }
  if (unchanged) return
  if (phase === undefined) out.push(itemStarted(ctx, item))
  out.push(itemCompleted(ctx, item))
}

/**
 * 完整 assistant 消息里的块对应哪个流式块。SDK 会把一条消息的每个内容块拆成单独的 assistant 消息，
 * 下标都从 0 开始，与流式 content_block 的 index 不一致；按下标对不上类型时，按类型 + 文本回找。
 */
function assistantBlockId(
  ctx: MapContext,
  state: MapState,
  messageId: string,
  index: number,
  kind: 'text' | 'thinking',
  text: string,
): string {
  const key = blockKey(messageId, index)
  const direct = state.blockIds[key]
  if (direct && state.blockKinds[direct] === kind) return direct
  const prefix = `${messageId}:`
  let fallback: string | undefined
  for (const [k, id] of Object.entries(state.blockIds)) {
    if (!k.startsWith(prefix) || state.blockKinds[id] !== kind) continue
    if (state.blockText[id] === text) return id
    if (!fallback && state.blockPhase?.[id] !== 'done') fallback = id
  }
  if (fallback) return fallback
  return ensureBlockItem(ctx, direct ? `${key}:${kind}` : key, kind, state)
}

function mapAssistant(message: Json, ctx: MapContext, state: MapState, out: V2Notification[]): void {
  const payload = asRecord(message.message)
  if (!payload) return
  const messageId = scalarText(payload.id) || state.messageId || 'assistant'
  const blocks = Array.isArray(payload.content) ? payload.content : []
  for (let index = 0; index < blocks.length; index++) {
    const block = asRecord(blocks[index])
    if (!block) continue
    const type = scalarText(block.type)
    if (type === 'text') {
      const id = assistantBlockId(ctx, state, messageId, index, 'text', scalarText(block.text))
      const item = agentMessageItem(id, scalarText(block.text))
      emitFinalBlock(ctx, state, id, item, scalarText(block.text), out)
    } else if (type === 'thinking') {
      const id = assistantBlockId(ctx, state, messageId, index, 'thinking', scalarText(block.thinking))
      const item = reasoningItem(id, scalarText(block.thinking))
      emitFinalBlock(ctx, state, id, item, scalarText(block.thinking), out)
    } else if (type === 'tool_use') {
      const name = scalarText(block.name)
      const toolId = scalarText(block.id) || `${messageId}:${index}`
      const existing = state.toolItems[toolId]
      const id = existing ? scalarText(existing.id) : newItemId(ctx, state, 'tool')
      const item = toolUseItem(id, name, block.input, ctx.cwd)
      state.toolItems[toolId] = item
      recordItem(state, item)
      out.push(itemStarted(ctx, item))
    }
  }
}

function mapUser(
  message: Json,
  ctx: MapContext,
  state: MapState,
  out: V2Notification[],
  options: MapOptions,
): void {
  const payload = asRecord(message.message)
  const content = payload?.content ?? message.content
  const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  // 带图片的用户消息合并成一个 userMessage（图片在前），否则界面会把文字与缩略图拆成两条气泡。
  if (options.includeUserText && blocks.some((raw) => asRecord(raw)?.type === 'image')) {
    const echo: Json[] = []
    for (const raw of blocks) {
      const block = asRecord(raw)
      if (block?.type === 'image') {
        const image = imageBlockToEcho(block)
        if (image) echo.push(image)
      } else if (block?.type === 'text' && scalarText(block.text)) {
        echo.push({ type: 'text', text: scalarText(block.text), text_elements: [] })
      }
    }
    if (echo.length > 0) {
      const item = userMessageContentItem(newItemId(ctx, state, 'user'), echo)
      recordItem(state, item)
      out.push(itemStarted(ctx, item), itemCompleted(ctx, item))
    }
  }
  const hasImage = options.includeUserText && blocks.some((raw) => asRecord(raw)?.type === 'image')
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (!block) continue
    const type = scalarText(block.type)
    if (type === 'text' && options.includeUserText && !hasImage) {
      const id = newItemId(ctx, state, 'user')
      const item = userMessageItem(id, scalarText(block.text))
      recordItem(state, item)
      out.push(itemStarted(ctx, item), itemCompleted(ctx, item))
      continue
    }
    if (type !== 'tool_result') continue
    const toolId = scalarText(block.tool_use_id)
    const errored = block.is_error === true
    const output = toolResultText(block.content)
    const existing = state.toolItems[toolId]
    const id = existing ? scalarText(existing.id) : newItemId(ctx, state, 'tool')
    const item: V2Item = { ...(existing ?? dynamicToolCallItem(id, 'tool', {})), id }
    if (item.type === 'commandExecution') {
      item.aggregatedOutput = output
      item.exitCode = errored ? 1 : 0
    } else if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
      item.contentItems = [{ type: 'text', text: output }]
      item.success = !errored
    }
    item.status = errored ? 'failed' : 'completed'
    state.toolItems[toolId] = item
    recordItem(state, item)
    out.push(itemCompleted(ctx, item))
  }
}

export function toolResultText(content: unknown): string {
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

function turnOutcome(message: Json): { status: string; error: string | null } {
  const subtype = scalarText(message.subtype)
  const errors = Array.isArray(message.errors) ? message.errors.map(scalarText).filter(Boolean) : []
  if (subtype === 'success' && message.is_error !== true) return { status: 'completed', error: null }
  if (subtype === 'error_during_execution') return { status: 'interrupted', error: null }
  const detail = errors[0] || scalarText(message.result) || `Claude turn 失败 (${subtype || 'unknown'})`
  return { status: 'failed', error: detail }
}

export function mapSdkMessage(
  message: unknown,
  ctx: MapContext,
  inputState: MapState,
  options: MapOptions = {},
): MapResult {
  const state = cloneState(inputState)
  const out: V2Notification[] = []
  const msg = asRecord(message)
  if (!msg) return { notifications: out, state }

  switch (msg.type) {
    case 'stream_event':
      mapStreamEvent(msg, ctx, state, out)
      break
    case 'assistant':
      mapAssistant(msg, ctx, state, out)
      break
    case 'user':
      mapUser(msg, ctx, state, out, options)
      break
    case 'result': {
      const { status, error } = turnOutcome(msg)
      out.push(...finishPendingItems(ctx, state, status === 'failed'))
      const items = state.order.map((id) => state.items[id]).filter(isRecord)
      const turn = buildTurn(ctx.turnId, items, status, error)
      out.push(notification('turn/completed', { threadId: ctx.threadId, turn }))
      out.push(
        notification('thread/tokenUsage/updated', {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          tokenUsage: tokenUsage(msg),
        }),
      )
      break
    }
    case 'rate_limit_event':
      out.push(
        notification('account/rateLimits/updated', {
          rateLimits: rateLimitSnapshot(msg.rate_limit_info),
        }),
      )
      break
    default:
      break
  }
  return { notifications: out, state }
}
