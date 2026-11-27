import type { ItemView, ThreadView, TurnEntry } from '@qn/codex-client'

export { formatDuration, groupFlow, groupTurns, isEmptyReasoning, streamingReplyId, turnTimeline, type FlowEntry, type TurnEntry } from '@qn/codex-client'

export function hasPendingSubmission(items: ItemView[], submitting: boolean): boolean {
  if (!submitting) return false
  const item = items.findLast((entry) => entry.kind === 'user' || (entry.kind === 'agent' && entry.text.trim()))
  return item?.kind === 'user' && item.pending === true
}

export function needsTurnProgress(thread: ThreadView, visibleEntries: readonly TurnEntry[]): boolean {
  if (thread.activity === 'input' || thread.activity === 'pending') return true
  const activeIds = thread.turns?.findLast((turn) => turn.id === thread.activeTurnId)?.itemIds
  const thinking = (item: ItemView) => item.kind === 'reasoning' && item.streaming && (activeIds?.includes(item.id) ?? true)
  // 正在思考的行或工具组已经显示了进度，只在当前轮次缺少这个提示时补一行。
  return !visibleEntries.some((entry) => entry.kind === 'item' ? thinking(entry.item)
    : entry.kind === 'tools' && entry.items.some(thinking))
}

export function formatStoppedDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return `${hours ? `${hours}小时` : ''}${hours || minutes ? `${minutes}分` : ''}${seconds % 60}秒`
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
