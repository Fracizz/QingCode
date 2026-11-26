import type { ItemView, TurnMeta } from '@qn/codex-client'

// 消息流分组（参考 Codex / Orca 的"已运行 3 条命令 · 1 个失败"）：
// 连续的工具类条目（命令、文件改动、思考、其他）折叠成一行摘要，对话正文不被过程信息淹没。

export type FlowEntry =
  | { kind: 'item'; key: string; item: ItemView }
  | { kind: 'tools'; key: string; items: ItemView[] }

export type TurnEntry =
  | FlowEntry
  /** 已结束一轮的过程（思考、工具、中间说明）收成"工作了 4m 56s"，只露出最终回复。 */
  | { kind: 'work'; key: string; durationMs: number | null; entries: FlowEntry[] }

export function hasPendingSubmission(items: ItemView[], submitting: boolean): boolean {
  if (!submitting) return false
  const item = items.findLast((entry) => entry.kind === 'user' || (entry.kind === 'agent' && entry.text.trim()))
  return item?.kind === 'user' && item.pending === true
}

/** 按用户消息切轮；进行中的那一轮保持展开，方便看实时进度。 */
export function groupTurns(items: ItemView[], turns: TurnMeta[] | undefined, running: boolean): TurnEntry[] {
  // 多轮共用一个条目索引，避免长会话的每个折叠组都扫描整份历史。
  const turnsByItem = new Map<string, TurnMeta[]>()
  for (const turn of turns ?? []) {
    if (!turn.durationMs) continue
    for (const id of turn.itemIds) {
      const matches = turnsByItem.get(id)
      if (matches) matches.push(turn)
      else turnsByItem.set(id, [turn])
    }
  }
  const segments: ItemView[][] = []
  for (const item of items) {
    if (item.kind === 'user' || segments.length === 0) segments.push([item])
    else segments[segments.length - 1]!.push(item)
  }
  const out: TurnEntry[] = []
  segments.forEach((segment, index) => {
    const head = segment[0]!.kind === 'user' ? segment[0]! : null
    const rest = head ? segment.slice(1) : segment
    if (head) out.push({ kind: 'item', key: head.id, item: head })
    const live = running && index === segments.length - 1
    let finalIndex = -1
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i]!.kind === 'agent') {
        finalIndex = i
        break
      }
    }
    const process = finalIndex >= 0 ? rest.slice(0, finalIndex) : rest
    if (live || process.length === 0 || !process.some(isTool)) {
      out.push(...groupFlow(rest))
      return
    }
    out.push({
      kind: 'work',
      key: `work-${process[0]!.id}`,
      durationMs: turnDuration(segment, turnsByItem),
      entries: groupFlow(process),
    })
    if (finalIndex >= 0) out.push(...groupFlow(rest.slice(finalIndex)))
  })
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
  const seconds = Math.max(1, Math.round(ms / 1000))
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

const running = (status: string) => /progress|running|started/i.test(status)

export function isGroupRunning(items: ItemView[]): boolean {
  return items.some((item) =>
    item.kind === 'command' || item.kind === 'fileChange'
      ? running(item.status)
      : item.kind === 'reasoning'
        ? item.streaming === true
        : false,
  )
}

export function summarizeTools(items: ItemView[]): string {
  let commands = 0
  let failed = 0
  let files = 0
  let thoughts = 0
  let others = 0
  for (const item of items) {
    if (item.kind === 'command') {
      commands++
      const exit = item.exitCode
      if ((exit !== null && exit !== undefined && exit !== 0) || /fail|error|denied|declined/i.test(item.status)) failed++
    } else if (item.kind === 'fileChange') {
      files += Math.max(1, item.changes.length)
    } else if (item.kind === 'reasoning') {
      thoughts++
    } else {
      others++
    }
  }
  const parts: string[] = []
  if (commands) parts.push(`已运行 ${commands} 条命令`)
  if (failed) parts.push(`${failed} 个失败`)
  if (files) parts.push(`编辑了 ${files} 个文件`)
  if (thoughts && parts.length === 0) parts.push(`思考了 ${thoughts} 次`)
  if (others) parts.push(`${others} 个其他步骤`)
  return parts.join(' · ') || `${items.length} 个步骤`
}
