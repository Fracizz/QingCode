const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 侧栏行尾用的紧凑相对时间：刚刚 / 5 分钟 / 3 小时 / 2 天，超过一周显示日期。 */
export function formatRelative(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = now - ms
  // 远端时钟略快时可能出现未来时间，按"刚刚"处理。
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天`
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const md = `${date.getMonth() + 1}/${date.getDate()}`
  return sameYear ? md : `${date.getFullYear()}/${md}`
}
