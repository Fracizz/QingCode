// Codex `account/usage/read` 的账号级 token 用量。协议类型把计数标成 bigint，
// 但经 JSON 传输后实际是 number（极端情况下可能是字符串），这里统一归一成 number。

export type AccountUsageDay = { date: string; tokens: number }

export type AccountUsage = {
  lifetimeTokens: number | null
  peakDailyTokens: number | null
  currentStreakDays: number | null
  longestStreakDays: number | null
  /** 按日期升序。 */
  daily: AccountUsageDay[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number | null {
  const n = typeof value === 'number' ? value
    : typeof value === 'bigint' ? Number(value)
      : typeof value === 'string' && value.trim() !== '' ? Number(value)
        : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 解析响应；summary 缺失或所有字段都为空时返回 null，界面显示"暂无"。 */
export function pickAccountUsage(value: unknown): AccountUsage | null {
  if (!isRecord(value) || !isRecord(value.summary)) return null
  const summary = value.summary
  const daily: AccountUsageDay[] = []
  if (Array.isArray(value.dailyUsageBuckets)) {
    for (const bucket of value.dailyUsageBuckets) {
      if (!isRecord(bucket) || typeof bucket.startDate !== 'string') continue
      const tokens = count(bucket.tokens)
      if (tokens !== null) daily.push({ date: bucket.startDate, tokens })
    }
  }
  // startDate 是 ISO 日期，按字符串排序即按时间排序。
  daily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const usage: AccountUsage = {
    lifetimeTokens: count(summary.lifetimeTokens),
    peakDailyTokens: count(summary.peakDailyTokens),
    currentStreakDays: count(summary.currentStreakDays),
    longestStreakDays: count(summary.longestStreakDays),
    daily,
  }
  const empty = usage.lifetimeTokens === null && usage.peakDailyTokens === null
    && usage.currentStreakDays === null && usage.longestStreakDays === null && daily.length === 0
  return empty ? null : usage
}

/** 取最近 days 个日桶（不补零：后端未返回的日子视为无数据）。 */
export function recentUsageDays(usage: AccountUsage | null | undefined, days: number): AccountUsageDay[] {
  if (!usage || days <= 0) return []
  return usage.daily.slice(-days)
}

export function sumUsageTokens(days: AccountUsageDay[]): number {
  return days.reduce((total, day) => total + day.tokens, 0)
}
