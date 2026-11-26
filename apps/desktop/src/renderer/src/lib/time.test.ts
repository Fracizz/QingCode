import { describe, expect, it } from 'vitest'
import { formatRelative } from './time'

const now = new Date(2026, 10, 25, 12, 0, 0).getTime()

describe('formatRelative', () => {
  it('一分钟内与未来时间显示刚刚', () => {
    expect(formatRelative(now - 20_000, now)).toBe('刚刚')
    expect(formatRelative(now + 60_000, now)).toBe('刚刚')
  })

  it('分钟、小时、天', () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 小时')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 天')
  })

  it('超过一周显示日期，跨年带年份', () => {
    expect(formatRelative(new Date(2026, 9, 9).getTime(), now)).toBe('10/9')
    expect(formatRelative(new Date(2025, 0, 3).getTime(), now)).toBe('2025/1/3')
  })

  it('无效时间返回空串', () => {
    expect(formatRelative(0, now)).toBe('')
    expect(formatRelative(Number.NaN, now)).toBe('')
  })
})
