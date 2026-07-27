export function formatRelativeTime(
  ts: number | null | undefined,
  t: (source: string, values?: Record<string, string | number>) => string,
  emptyLabel = '--',
): string {
  if (ts == null || ts <= 0) return emptyLabel
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  if (diff < minute) return t('刚刚')
  if (diff < hour) return t('{count} 分钟前', { count: Math.floor(diff / minute) })
  if (diff < day) return t('{count} 小时前', { count: Math.floor(diff / hour) })
  if (diff < month) return t('{count} 天前', { count: Math.floor(diff / day) })
  if (diff < 12 * month) {
    return t('{count} 个月前', { count: Math.max(1, Math.floor(diff / month)) })
  }
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function latestTimestamp(...values: Array<number | null | undefined>): number | null {
  let best = 0
  for (const value of values) {
    if (value != null && value > best) best = value
  }
  return best > 0 ? best : null
}
