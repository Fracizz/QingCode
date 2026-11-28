/**
 * 子代理内部消息（带 parent_tool_use_id）归到主对话里发起它的 Agent 卡片（纯函数）。
 * 卡片按会话保留：后台子代理在发起轮次结束后仍会继续发消息。更新时返回新对象。
 */
import { asRecord, scalarText, summarizeInput, type Json, type V2Item } from './v2'

export interface SubagentActivity {
  /** 子代理内部工具调用的 tool_use id。 */
  id: string
  tool: string
  summary: string
  status: 'inProgress' | 'completed' | 'failed'
}

export interface SubagentCard {
  turnId: string
  item: V2Item
}

export interface Sidechains {
  /** 主代理 Agent / Task 调用的 tool_use id → 卡片。 */
  cards: ReadonlyMap<string, SubagentCard>
  /** 子代理内部 tool_use id → 所属卡片；嵌套子代理并入最外层卡片。 */
  nested: ReadonlyMap<string, string>
}

// 每次更新都会重发整张卡片，限制条数和摘要长度控制帧大小。
const MAX_ACTIVITY = 100
const MAX_SUMMARY = 200
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill']

export function emptySidechains(): Sidechains {
  return { cards: new Map(), nested: new Map() }
}

export function isSubagentItem(item: V2Item): boolean {
  return item.type === 'dynamicToolCall' && item.namespace === 'claude' && (item.tool === 'Agent' || item.tool === 'Task')
}

export function subagentActivity(item: V2Item): SubagentActivity[] {
  return Array.isArray(item.activity) ? item.activity as SubagentActivity[] : []
}

/** 登记或刷新卡片；归属轮次不变，条目自带活动记录时以它为准。返回应当写入会话的条目。 */
export function trackCard(
  chains: Sidechains,
  toolUseId: string,
  turnId: string,
  item: V2Item,
): { chains: Sidechains; item: V2Item } {
  const previous = chains.cards.get(toolUseId)
  const own = subagentActivity(item)
  const activity = own.length || !previous ? own : subagentActivity(previous.item)
  const next: V2Item = { ...item, toolUseId, ...(activity.length ? { activity } : {}) }
  const cards = new Map(chains.cards).set(toolUseId, { turnId: previous?.turnId ?? turnId, item: next })
  return { chains: { cards, nested: chains.nested }, item: next }
}

/** 子代理审批归到所属卡片；不是子代理内部的调用返回空串。 */
export function sidechainItemId(chains: Sidechains, toolUseId: string): string {
  const root = chains.nested.get(toolUseId)
  return root ? scalarText(chains.cards.get(root)?.item.id) : ''
}

/**
 * 子代理的工具调用与结果记入活动列表；文本、思考和流式增量不进主对话。
 * 卡片没有变化或找不到归属时 card 为 null。
 */
export function applySidechainMessage(
  chains: Sidechains,
  parentToolUseId: string,
  message: Json,
): { chains: Sidechains; card: SubagentCard | null } {
  const root = chains.cards.has(parentToolUseId) ? parentToolUseId : chains.nested.get(parentToolUseId)
  const card = root ? chains.cards.get(root) : undefined
  const content = asRecord(message.message)?.content
  if (!root || !card || !Array.isArray(content)) return { chains, card: null }
  let activity = subagentActivity(card.item)
  let nested = chains.nested
  let changed = false
  for (const raw of content) {
    const block = asRecord(raw)
    if (message.type === 'assistant' && block?.type === 'tool_use') {
      const id = scalarText(block.id)
      if (!id || activity.some((entry) => entry.id === id)) continue
      nested = new Map(nested).set(id, root)
      activity = [...activity, {
        id, tool: scalarText(block.name), summary: activitySummary(block.input), status: 'inProgress' as const,
      }].slice(-MAX_ACTIVITY)
      changed = true
    } else if (message.type === 'user' && block?.type === 'tool_result') {
      const id = scalarText(block.tool_use_id)
      const status = block.is_error === true ? 'failed' as const : 'completed' as const
      if (!activity.some((entry) => entry.id === id && entry.status !== status)) continue
      activity = activity.map((entry) => entry.id === id ? { ...entry, status } : entry)
      changed = true
    }
  }
  if (!changed) return { chains, card: null }
  const next: SubagentCard = { turnId: card.turnId, item: { ...card.item, activity } }
  return { chains: { cards: new Map(chains.cards).set(root, next), nested }, card: next }
}

/** 子代理结束或被停止后，没收到结果的活动一并收尾；没有变化时返回原条目。 */
export function settleActivity(item: V2Item, status: 'completed' | 'failed'): V2Item {
  const activity = subagentActivity(item)
  if (!activity.some((entry) => entry.status === 'inProgress')) return item
  return { ...item, activity: activity.map((entry) => entry.status === 'inProgress' ? { ...entry, status } : entry) }
}

/** 历史接口不返回子代理内部消息，本进程记下的活动补回历史卡片。 */
export function withActivity(turns: Json[], chains: Sidechains): Json[] {
  if (chains.cards.size === 0) return turns
  return turns.map((turn) => {
    if (!Array.isArray(turn.items)) return turn
    let changed = false
    const items = turn.items.map((item: V2Item) => {
      const card = chains.cards.get(scalarText(item.toolUseId))
      if (!card || subagentActivity(card.item).length <= subagentActivity(item).length) return item
      changed = true
      return { ...item, activity: subagentActivity(card.item) }
    })
    return changed ? { ...turn, items } : turn
  })
}

function activitySummary(input: unknown): string {
  const record = asRecord(input)
  const key = SUMMARY_KEYS.find((name) => scalarText(record?.[name]))
  const text = key ? scalarText(record?.[key]) : summarizeInput(input)
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text
}
