import { describe, expect, it } from 'vitest'
import { pickAccountUsage, recentUsageDays, sumUsageTokens } from './accountUsage'

describe('pickAccountUsage', () => {
  it('归一数字与字符串计数，并按日期升序', () => {
    const usage = pickAccountUsage({
      summary: { lifetimeTokens: 1_234_567, peakDailyTokens: '90000', longestRunningTurnSec: 30, currentStreakDays: 3, longestStreakDays: null },
      dailyUsageBuckets: [
        { startDate: '2026-11-26', tokens: 200 },
        { startDate: '2026-11-24', tokens: '100' },
        { startDate: '2026-11-25', tokens: -1 },
        { startDate: 5, tokens: 1 },
      ],
    })
    expect(usage).toEqual({
      lifetimeTokens: 1_234_567,
      peakDailyTokens: 90000,
      currentStreakDays: 3,
      longestStreakDays: null,
      daily: [{ date: '2026-11-24', tokens: 100 }, { date: '2026-11-26', tokens: 200 }],
    })
  })

  it('无 summary 或全空时返回 null', () => {
    expect(pickAccountUsage(null)).toBeNull()
    expect(pickAccountUsage({ dailyUsageBuckets: [] })).toBeNull()
    expect(pickAccountUsage({
      summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
      dailyUsageBuckets: null,
    })).toBeNull()
  })
})

describe('recentUsageDays', () => {
  it('取末尾若干天并求和', () => {
    const usage = pickAccountUsage({
      summary: { lifetimeTokens: 10 },
      dailyUsageBuckets: [1, 2, 3].map((d) => ({ startDate: `2026-11-0${d}`, tokens: d })),
    })
    const days = recentUsageDays(usage, 2)
    expect(days.map((d) => d.date)).toEqual(['2026-11-02', '2026-11-03'])
    expect(sumUsageTokens(days)).toBe(5)
    expect(recentUsageDays(null, 7)).toEqual([])
  })
})
