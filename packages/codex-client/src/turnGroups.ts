import { t } from '../../protocol/src/i18n'
import type { ItemView, ThreadView, TurnMeta } from './conversation'

type MessageEntry = { kind: 'item'; key: string; item: ItemView }

type StoppedTurnEntry = { kind: 'stopped'; key: string; durationMs: number | null }
type TimelineEntry = MessageEntry | StoppedTurnEntry

export type FlowEntry = MessageEntry | { kind: 'tools'; key: string; items: ItemView[] }

export type TurnEntry =
  | FlowEntry
  | StoppedTurnEntry
  /** 已结束一轮的过程（思考、工具、中间说明）收成"工作了 4m 56s"，只露出最终回复。 */
  | { kind: 'work'; key: string; durationMs: number | null; entries: FlowEntry[]; reply?: { id: string; completedAtMs?: number } }

/** 分页起点落在最终回复时，让对应的工作摘要和回复一起显示。 */
export function includeWorkSummary(
  timeline: readonly { kind: string; key: string; reply?: { id: string } }[], start: number,
): number {
  const previous = timeline[start - 1]
  const first = timeline[start]
  return previous?.kind === 'work' && first && previous.reply?.id === first.key ? start - 1 : start
}

export function isEmptyReasoning(item: ItemView): boolean {
  return item.kind === 'reasoning' && !item.streaming && !item.summary.trim()
}

export function streamingReplyId(thread: ThreadView | undefined): string | undefined {
  if (thread?.status !== 'running') return
  const itemIds = thread.turns?.findLast((turn) => turn.id === thread.activeTurnId)?.itemIds
  if (itemIds?.length === 0) return
  // 命令或新回复会接管指示，异步到达的任务通知不影响正在输出的回复。
  const last = thread.items.findLast((item) => item.kind !== 'backgroundTask' && (!itemIds || itemIds.includes(item.id)))
  if (last?.kind === 'agent' && last.streaming && last.text.trim()) return last.id
}

export function turnTimeline(items: readonly ItemView[], turns: readonly TurnMeta[] | undefined): TimelineEntry[] {
  const messages = items.map((item): MessageEntry => ({ kind: 'item', key: item.id, item }))
  if (!turns?.some((turn) => turn.outcome === 'interrupted')) return messages

  const positions = new Map(items.map((item, index) => [item.id, index]))
  const stops = new Map<number, StoppedTurnEntry[]>()
  const stopByItem = new Map<string, StoppedTurnEntry>()
  let nextStart = items.length
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    let first = items.length
    let last = -1
    for (const id of turn.itemIds) {
      const position = positions.get(id)
      if (position === undefined) continue
      first = Math.min(first, position)
      last = Math.max(last, position)
    }
    // 尚未有条目的停止轮次放在下一轮之前，未加载条目的历史轮次等翻页后再显示。
    if (turn.outcome === 'interrupted' && (last >= 0 || turn.itemIds.length === 0)) {
      // 同一轮可能同时留有实时记录和历史记录（轮次 ID 不同、条目相同），只提示一次。
      const same = turn.itemIds.map((id) => stopByItem.get(id)).find(Boolean)
      if (same) same.durationMs ??= turn.durationMs
      else {
        const position = last >= 0 ? last + 1 : nextStart
        const entry: StoppedTurnEntry = { kind: 'stopped', key: `stopped-${turn.id}`, durationMs: turn.durationMs }
        for (const id of turn.itemIds) stopByItem.set(id, entry)
        const existing = stops.get(position)
        if (existing) existing.push(entry)
        else stops.set(position, [entry])
      }
    }
    if (last >= 0) nextStart = first
  }

  const timeline: TimelineEntry[] = []
  messages.forEach((message, index) => {
    timeline.push(...(stops.get(index)?.reverse() ?? []), message)
  })
  timeline.push(...(stops.get(items.length)?.reverse() ?? []))
  return timeline
}

/** 按用户消息切轮；进行中的那一轮保持展开，方便看实时进度。 */
export function groupTurns(items: readonly ItemView[], turns: readonly TurnMeta[] | undefined, running: boolean): TurnEntry[] {
  // 多轮共用一个条目索引，避免长会话的每个折叠组都扫描整份历史。
  const turnsByItem = new Map<string, TurnMeta[]>()
  for (const turn of turns ?? []) {
    if (turn.durationMs === null) continue
    for (const id of turn.itemIds) {
      const matches = turnsByItem.get(id)
      if (matches) matches.push(turn)
      else turnsByItem.set(id, [turn])
    }
  }
  const out: TurnEntry[] = []
  let itemsInSegment: ItemView[] = []
  const flush = (live: boolean) => {
    if (itemsInSegment.length === 0) return
    const segment = itemsInSegment
    itemsInSegment = []
    const head = segment[0]!.kind === 'user' ? segment[0]! : null
    const rest = head ? segment.slice(1) : segment
    if (head) out.push({ kind: 'item', key: head.id, item: head })
    let finalIndex = -1
    for (let i = rest.length - 1; i >= 0; i--) {
      const item = rest[i]!
      if (item.kind === 'agent' && item.text.trim()) {
        finalIndex = i
        break
      }
    }
    const process = finalIndex >= 0 ? rest.slice(0, finalIndex) : rest
    if (live || !process.some((item) => isTool(item) && !isEmptyReasoning(item))) {
      out.push(...groupFlow(rest))
      return
    }
    const finalReply = rest[finalIndex]
    out.push({
      kind: 'work',
      key: `work-${process[0]!.id}`,
      durationMs: turnDuration(segment, turnsByItem),
      entries: groupFlow(process),
      ...(finalReply?.kind === 'agent' && !finalReply.streaming
        ? { reply: { id: finalReply.id, completedAtMs: finalReply.completedAtMs } } : {}),
    })
    if (finalIndex >= 0) out.push(...groupFlow(rest.slice(finalIndex)))
  }
  // 主对话在页头集中展示子代理，保留它们在时间线中的位置以定位停止提示。
  const liveItems = new Set(running ? turns?.findLast((turn) => turn.outcome === undefined)?.itemIds : [])
  for (const entry of turnTimeline(items, turns)) {
    if (entry.kind === 'stopped') {
      flush(false)
      out.push(entry)
    } else if (entry.item.kind !== 'subagent') {
      if (entry.item.kind === 'notice') {
        flush(false)
        out.push(entry)
        continue
      }
      if (entry.item.kind === 'backgroundTask') {
        flush(itemsInSegment.some((item) => liveItems.has(item.id)))
        out.push(entry)
        continue
      }
      if (entry.item.kind === 'other' && entry.item.type === 'contextCompaction') {
        const user = itemsInSegment[0]
        const insideUserTurn = user?.kind === 'user' && turns?.some((turn) =>
          turn.itemIds.includes(user.id) && turn.itemIds.includes(entry.item.id))
        if (!insideUserTurn) {
          flush(false)
          out.push(entry)
          continue
        }
      }
      if (entry.item.kind === 'user') flush(false)
      itemsInSegment.push(entry.item)
    }
  }
  flush(running)
  return out
}

function turnDuration(segment: ItemView[], turnsByItem: Map<string, TurnMeta[]>): number | null {
  const matching = new Set<TurnMeta>()
  for (const item of segment) {
    for (const turn of turnsByItem.get(item.id) ?? []) matching.add(turn)
  }
  let total = 0
  // 一条用户消息可能对应多轮（重试、续跑），累加起来。
  for (const turn of matching) total += turn.durationMs ?? 0
  return matching.size ? total : null
}

export function formatDuration(ms: number): string {
  const seconds = ms === 0 ? 0 : Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const isTool = (item: ItemView): boolean =>
  item.kind === 'command' || item.kind === 'fileChange' || item.kind === 'reasoning' || item.kind === 'other'

/** 至少 2 个连续工具条目才分组；单个工具条目保持原样，免得多点一次才能看到。 */
export function groupFlow(items: ItemView[]): FlowEntry[] {
  const entries: FlowEntry[] = []
  let run: ItemView[] = []
  const flush = () => {
    if (run.length >= 2) entries.push({ kind: 'tools', key: `tools-${run[0]!.id}`, items: run })
    else for (const item of run) entries.push({ kind: 'item', key: item.id, item })
    run = []
  }
  for (const item of items) {
    if (isEmptyReasoning(item)) continue
    if (isTool(item)) {
      run.push(item)
    } else {
      flush()
      entries.push({ kind: 'item', key: item.id, item })
    }
  }
  flush()
  return entries
}

export function workSummaryLabel(durationMs: number | null): string {
  return durationMs === null ? t('工作过程') : t('工作了 {duration}', { duration: formatDuration(durationMs) })
}
