import { groupTurns, type ItemView, type ThreadView, type TurnMeta } from '@qn/codex-client'

/** 子代理单独显示，便于从消息流直接查看。 */
export type ToolItem = Exclude<ItemView, { kind: 'user' | 'agent' | 'reasoning' | 'subagent' }>

export type ChatBlock =
  | { kind: 'item'; item: ItemView }
  | { kind: 'tools'; id: string; items: ToolItem[] }

export type ToolStatus = 'running' | 'failed' | 'done'

export function streamingReplyId(thread: ThreadView | undefined): string | undefined {
  if (thread?.status !== 'running') return
  const itemIds = thread.turns?.findLast((turn) => turn.id === thread.activeTurnId)?.itemIds
  if (itemIds?.length === 0) return
  // 命令或新回复接管后，不能让还没收到完成事件的旧回复重新出现指示。
  const last = itemIds ? thread.items.findLast((item) => itemIds.includes(item.id)) : thread.items.at(-1)
  if (last?.kind === 'agent' && last.streaming && last.text.trim()) return last.id
}

const isTool = (item: ItemView): item is ToolItem =>
  item.kind === 'command' || item.kind === 'fileChange' || (item.kind === 'other' && item.type !== 'contextCompaction')

export function toolStatus(item: ToolItem): ToolStatus {
  const status = 'status' in item && typeof item.status === 'string' ? item.status : ''
  if (/progress|running|started/i.test(status)) return 'running'
  if (/fail|error|denied|declined/i.test(status)) return 'failed'
  if (item.kind === 'command' && typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed'
  return 'done'
}

/**
 * 连续 2 个及以上工具步骤折叠成一行摘要（参考电脑版与 Orca），单个步骤原样显示；
 * 手机屏幕上一长串命令卡片会把真正的回复挤出视野。
 */
export function groupChatItems(items: readonly ItemView[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let run: ToolItem[] = []
  const flush = () => {
    if (run.length >= 2) blocks.push({ kind: 'tools', id: `tools:${run[0]!.id}`, items: run })
    else for (const item of run) blocks.push({ kind: 'item', item })
    run = []
  }
  for (const item of items) {
    if (isTool(item)) {
      run.push(item)
      continue
    }
    flush()
    blocks.push({ kind: 'item', item })
  }
  flush()
  return blocks
}

/** 摘要文案：「已运行 3 条命令 · 改动 2 个文件 · 1 个失败」，仍在运行时改为进行时。 */
export function toolSummary(items: readonly ToolItem[]): string {
  const commands = items.filter((item) => item.kind === 'command').length
  const files = items
    .filter((item) => item.kind === 'fileChange')
    .reduce((total, item) => total + (item.kind === 'fileChange' ? Math.max(1, item.changes.length) : 0), 0)
  const others = items.length - commands - items.filter((item) => item.kind === 'fileChange').length
  const failed = items.filter((item) => toolStatus(item) === 'failed').length
  const running = items.some((item) => toolStatus(item) === 'running')
  const parts: string[] = []
  if (commands) parts.push(`${running ? '正在运行' : '已运行'} ${commands} 条命令`)
  if (files) parts.push(`改动 ${files} 个文件`)
  if (others) parts.push(`${others} 个其它步骤`)
  if (failed) parts.push(`${failed} 个失败`)
  return parts.join(' · ') || `${items.length} 个步骤`
}

/** 手机消息流只保留对话本身、文件改动、子代理和上下文压缩提示。 */
export function isChatVisible(item: ItemView): boolean {
  if (item.kind === 'reasoning' || item.kind === 'command') return false
  if (item.kind === 'other') return item.type === 'contextCompaction'
  return true
}

export type WorkSummary = { durationMs: number | null; reply?: { id: string; completedAtMs?: number } }

/** 工作摘要沿用桌面分轮，挂在对应的最后一条回复或最近的可见步骤上。 */
export function chatWorkSummaries(items: ItemView[], turns: TurnMeta[] | undefined, running: boolean): Map<string, WorkSummary> {
  const summaries = new Map<string, WorkSummary>()
  let anchor: string | undefined
  for (const entry of groupTurns(items, turns, running)) {
    if (entry.kind === 'stopped') anchor = undefined
    if (entry.kind === 'item' && isChatVisible(entry.item)) anchor = entry.item.id
    if (entry.kind !== 'work') continue
    for (const step of entry.entries) {
      const visible = step.kind === 'item' ? (isChatVisible(step.item) ? step.item : undefined) : step.items.findLast(isChatVisible)
      if (visible) anchor = visible.id
    }
    const id = entry.reply?.id ?? anchor
    if (id) summaries.set(id, { durationMs: entry.durationMs, reply: entry.reply })
  }
  return summaries
}

export function interruptedTurnPositions(items: readonly ItemView[], shown: readonly ItemView[], turns?: readonly TurnMeta[]) {
  const stops = new Map<number, string[]>()
  if (!turns?.some((turn) => turn.outcome === 'interrupted')) return stops

  const visible = new Set(shown.map((item) => item.id))
  const positions = new Map<string, { before: number; after: number }>()
  let count = 0
  for (const item of items) {
    const before = count
    if (visible.has(item.id)) count += 1
    positions.set(item.id, { before, after: count })
  }

  let nextStart = count
  for (const turn of [...turns].reverse()) {
    let first = Infinity
    let last = -1
    for (const id of turn.itemIds) {
      const position = positions.get(id)
      if (!position) continue
      first = Math.min(first, position.before)
      last = Math.max(last, position.after)
    }
    if (turn.outcome === 'interrupted' && (last >= 0 || turn.itemIds.length === 0)) {
      const anchor = last >= 0 ? last : nextStart
      stops.set(anchor, [turn.id, ...(stops.get(anchor) ?? [])])
    }
    if (last >= 0) nextStart = first
  }
  return stops
}

/** 根据本轮最新一步推断回复阶段，命令被隐藏后仍让用户知道在忙什么。 */
export function replyPhase(items: readonly ItemView[], activeIds: readonly string[] | undefined): string {
  if (!activeIds?.length) return '正在思考'
  const ids = new Set(activeIds)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (!ids.has(item.id) || item.kind === 'user') continue
    if (item.kind === 'agent') return item.streaming ? '正在回复' : '正在思考'
    if (item.kind === 'command') return '正在执行命令'
    if (item.kind === 'fileChange') return '正在修改文件'
    if (item.kind === 'reasoning') return '正在思考'
    return '正在处理'
  }
  return '正在思考'
}

/**
 * 被隐藏的命令等工具步骤按轮次收拢，挂在该轮最后一条可见消息后面，
 * 平时只占一行摘要，排查问题时再点开看。activeIds 内的步骤属于进行中的一轮，先不显示。
 */
export function hiddenToolTrails(items: readonly ItemView[], activeIds?: readonly string[]): Map<string, ToolItem[]> {
  const trails = new Map<string, ToolItem[]>()
  const active = new Set(activeIds ?? [])
  let anchor: string | undefined
  let hidden: ToolItem[] = []
  const flush = () => {
    if (anchor && hidden.length) trails.set(anchor, hidden)
    hidden = []
  }
  for (const item of items) {
    if (item.kind === 'user') {
      flush()
      anchor = item.id
    } else if (isChatVisible(item)) {
      anchor = item.id
    } else if (isTool(item) && !active.has(item.id)) {
      hidden.push(item)
    }
  }
  flush()
  return trails
}
