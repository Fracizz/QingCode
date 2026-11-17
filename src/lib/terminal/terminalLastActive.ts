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
 * 列表行尾的紧凑相对时间：「刚刚」「5分钟前」「3小时前」「4天前」「2个月前」「1年前」。
 * 带「前」字，一眼看出是最近活动距今多久，而不是运行时长；数字与单位之间不留空格，窄侧栏里更紧凑。
 */
export function formatTerminalAge(at: number | null | undefined, now: number, t: Translate): string | null {
  if (!validTime(at)) return null
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return t('刚刚')
  if (diff < HOUR) return t('{count}分钟前', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('{count}小时前', { count: Math.floor(diff / HOUR) })
  if (diff < MONTH) return t('{count}天前', { count: Math.floor(diff / DAY) })
  if (diff < YEAR) return t('{count}个月前', { count: Math.floor(diff / MONTH) })
  return t('{count}年前', { count: Math.floor(diff / YEAR) })
}
