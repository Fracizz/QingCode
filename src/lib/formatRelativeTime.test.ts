import { describe, expect, it, vi } from 'vitest'
import { formatRelativeTime } from './formatRelativeTime'

const t = (source: string, values?: Record<string, string | number>) => {
  if (values?.count != null) return source.replace('{count}', String(values.count))
  return source
}

describe('formatRelativeTime', () => {
  it('returns placeholder when timestamp is missing', () => {
    expect(formatRelativeTime(null, t)).toBe('--')
  })

  it('formats months ago for older timestamps', () => {
    const now = Date.UTC(2026, 6, 27, 12, 0, 0)
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const threeMonthsAgo = now - 90 * 24 * 60 * 60 * 1000
    expect(formatRelativeTime(threeMonthsAgo, t)).toBe('3 个月前')
    vi.useRealTimers()
  })
})
