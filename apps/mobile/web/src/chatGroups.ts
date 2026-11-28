import { groupTurns, mergeAdjacentStops, t, type ItemView, type TurnEntry, type TurnMeta } from '@qn/codex-client'

export { streamingReplyId } from '@qn/codex-client'

/** 子代理单独显示，便于从消息流直接查看。 */
export type ToolItem = Exclude<ItemView, { kind: 'user' | 'agent' | 'reasoning' | 'subagent' }>

export type ChatBlock =
  | { kind: 'item'; item: ItemView }
  | { kind: 'tools'; id: string; items: ToolItem[] }

export type WorkGroupEntry = Extract<TurnEntry, { kind: 'work' }>

type ChatTimelineEntry = WorkGroupEntry | Extract<TurnEntry, { kind: 'stopped' }>
  | { kind: 'visible'; key: string; block: ChatBlock; trail?: ToolItem[]; finalReply: boolean }

export type ToolStatus = 'running' | 'failed' | 'done'

const isTool = (item: ItemView): item is ToolItem =>
  item.kind === 'command' || item.kind === 'fileChange' || (item.kind === 'other' && item.type !== 'contextCompaction')

export function toolStatus(item: ItemView): ToolStatus {
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
export function toolSummary(items: readonly ItemView[]): string {
  const commands = items.filter((item) => item.kind === 'command').length
  const files = items
    .filter((item) => item.kind === 'fileChange')
    .reduce((total, item) => total + (item.kind === 'fileChange' ? Math.max(1, item.changes.length) : 0), 0)
  const thoughts = items.filter((item) => item.kind === 'reasoning').length
  const others = items.length - commands - items.filter((item) => item.kind === 'fileChange').length - thoughts
  const failed = items.filter((item) => toolStatus(item) === 'failed').length
  const running = items.some((item) => toolStatus(item) === 'running')
  const parts: string[] = []
  if (commands) {
    const one = commands === 1
    parts.push(running
      ? (one ? t('正在运行 1 条命令') : t('正在运行 {count} 条命令', { count: commands }))
      : (one ? t('已运行 1 条命令') : t('已运行 {count} 条命令', { count: commands })))
  }
  if (files) parts.push(files === 1 ? t('改动 1 个文件') : t('改动 {count} 个文件', { count: files }))
  if (thoughts && parts.length === 0) parts.push(thoughts === 1 ? t('思考了 1 次') : t('思考了 {count} 次', { count: thoughts }))
  if (others) parts.push(others === 1 ? t('1 个其它步骤') : t('{count} 个其它步骤', { count: others }))
  if (failed) parts.push(t('{count} 个失败', { count: failed }))
  return parts.join(' · ') || (items.length === 1 ? t('1 个步骤') : t('{count} 个步骤', { count: items.length }))
}

/** 手机消息流只保留对话本身、文件改动、子代理和上下文压缩提示。 */
export function isChatVisible(item: ItemView): boolean {
  if (item.kind === 'reasoning' || item.kind === 'command') return false
  if (item.kind === 'other') return item.type === 'contextCompaction'
  return true
}

/** 已完成的工作组直接沿用桌面顺序，组外的进行中条目保持手机端的精简展示。 */
export function chatTimeline(items: readonly ItemView[], turns: readonly TurnMeta[] | undefined, running: boolean,
  activeIds?: readonly string[]): ChatTimelineEntry[] {
  const timeline: ChatTimelineEntry[] = []
  let pending: ItemView[] = []
  const flush = () => {
    if (!pending.length) return
    const trails = hiddenToolTrails(pending, activeIds)
    const visible = groupChatItems(pending.filter(isChatVisible))
    const entries: ChatTimelineEntry[] = []
    let seenReply = false
    for (const block of visible.reverse()) {
      const id = block.kind === 'item' ? block.item.id : block.items.at(-1)!.id
      const kind = block.kind === 'item' ? block.item.kind : undefined
      entries.push({ kind: 'visible', key: block.kind === 'item' ? id : block.id, block, trail: trails.get(id),
        finalReply: kind === 'agent' && !seenReply })
      if (kind === 'agent' || kind === 'user') seenReply = kind === 'agent'
    }
    timeline.push(...entries.reverse())
    pending = []
  }
  for (const entry of groupTurns(items, turns, running)) {
    if (entry.kind === 'item') pending.push(entry.item)
    else if (entry.kind === 'tools') pending.push(...entry.items)
    else {
      flush()
      timeline.push(entry)
    }
  }
  flush()
  // 命令等步骤在手机上隐藏，隔着它们的两条停止提示看起来是挨着的。
  return mergeAdjacentStops(timeline)
}

/** 根据本轮最新一步推断回复阶段，命令被隐藏后仍让用户知道在忙什么。 */
export function replyPhase(items: readonly ItemView[], activeIds: readonly string[] | undefined): string {
  if (!activeIds?.length) return t('正在思考')
  const ids = new Set(activeIds)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (!ids.has(item.id) || item.kind === 'user' || item.kind === 'backgroundTask') continue
    if (item.kind === 'agent') return item.streaming ? t('正在回复') : t('正在思考')
    if (item.kind === 'command') return t('正在执行命令')
    if (item.kind === 'fileChange') return t('正在修改文件')
    if (item.kind === 'reasoning') return t('正在思考')
    return t('正在处理')
  }
  return t('正在思考')
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
