import type { TerminalTab } from '../../types'

type Translate = (source: string, values?: Record<string, string | number>) => string

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

function validTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 终端最后一次有意义的活动时间；旧快照没有记录时依次退回到退出时间、创建时间。
 * 都没有时返回 null，列表行尾不显示时间。
 */
export function terminalLastActiveAt(
  terminal: Pick<TerminalTab, 'lastActiveAt' | 'endedAt' | 'createdAt' | 'startedAt'>,
): number | null {
  const candidates = [terminal.lastActiveAt, terminal.endedAt, terminal.createdAt ?? terminal.startedAt]
  return candidates.find(validTime) ?? null
}

/**
 * 列表行尾的紧凑相对时间：「刚刚」「5分钟」「3小时」「4天」「2个月」「1年」。
 * 不带「前」字，和参考产品一致，窄侧栏里也能对齐成一列。
 */
export function formatTerminalAge(at: number | null | undefined, now: number, t: Translate): string | null {
  if (!validTime(at)) return null
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return t('刚刚')
  if (diff < HOUR) return t('{count}分钟', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('{count}小时', { count: Math.floor(diff / HOUR) })
  if (diff < MONTH) return t('{count}天', { count: Math.floor(diff / DAY) })
  if (diff < YEAR) return t('{count}个月', { count: Math.floor(diff / MONTH) })
  return t('{count}年', { count: Math.floor(diff / YEAR) })
}
