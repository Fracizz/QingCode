import { getLocale, t, type ItemView, type ThreadView, type TurnEntry } from '@qn/codex-client'

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
  const en = getLocale() === 'en'
  return [
    hours ? `${hours}${en ? 'h' : '小时'}` : '', // i18n-ignore: 紧凑时长单位
    hours || minutes ? `${minutes}${en ? 'm' : '分'}` : '', // i18n-ignore: 紧凑时长单位
    `${seconds % 60}${en ? 's' : '秒'}`, // i18n-ignore: 紧凑时长单位
  ].filter(Boolean).join(en ? ' ' : '')
}

const running = (status: string) => /progress|running|started/i.test(status)

export function isGroupRunning(items: ItemView[]): boolean {
  return items.some((item) =>
    item.kind === 'command' || item.kind === 'fileChange' || item.kind === 'other'
      ? running(item.status ?? '')
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
      if (item.kind === 'other' && item.status && /fail|error|denied|declined/i.test(item.status)) failed++
    }
  }
  const parts: string[] = []
  // 单数单独成词条，英文才能用正确的单复数。
  if (commands) parts.push(commands === 1 ? t('已运行 1 条命令') : t('已运行 {count} 条命令', { count: commands }))
  if (failed) parts.push(t('{count} 个失败', { count: failed }))
  if (files) parts.push(files === 1 ? t('编辑了 1 个文件') : t('编辑了 {count} 个文件', { count: files }))
  if (thoughts && parts.length === 0) parts.push(thoughts === 1 ? t('思考了 1 次') : t('思考了 {count} 次', { count: thoughts }))
  if (others) parts.push(others === 1 ? t('1 个其他步骤') : t('{count} 个其他步骤', { count: others }))
  if (parts.length) return parts.join(' · ')
  return items.length === 1 ? t('1 个步骤') : t('{count} 个步骤', { count: items.length })
}
