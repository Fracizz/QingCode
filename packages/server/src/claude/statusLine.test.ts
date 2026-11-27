import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeStatusLine, statusLineWindows } from './statusLine'

afterEach(() => vi.useRealTimers())

describe('Claude CLI 状态栏额度', () => {
  it('区分 5 小时与每周窗口并保留真实的 0%', () => {
    expect(statusLineWindows({
      five_hour: { used_percentage: 0, resets_at: 1_800_000_000, ignored: '不复制' },
      seven_day: { used_percentage: 101, resets_at: 1_800_000_000 },
      spend_limit: { used_percentage: 1, resets_at: 1_800_000_000 },
    })).toEqual({
      primary: { usedPercent: 0, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      secondary: null,
    })
  })

  it('合并限时内的更新，忽略迟到快照并在重置时逐个移除窗口', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const onChange = vi.fn()
    const feed = new ClaudeStatusLine(onChange)
    try {
      const fiveHour = (used_percentage: number, resets_at = 1_800_000_020) => ({ used_percentage, resets_at })
      feed.ingest({ five_hour: fiveHour(10) })
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(feed.snapshot().observedAt).toBe(1_800_000_000_000)
      vi.advanceTimersByTime(1_000)
      feed.ingest({
        five_hour: fiveHour(24),
        seven_day: { used_percentage: 48, resets_at: 1_800_000_030 },
      })
      feed.ingest({ five_hour: fiveHour(15) })
      feed.ingest({ five_hour: fiveHour(99, 1_800_000_018) })
      vi.advanceTimersByTime(13_999)
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(feed.snapshot().primary?.usedPercent).toBe(10)
      vi.advanceTimersByTime(1)
      expect(feed.snapshot().primary?.usedPercent).toBe(24)
      expect(feed.snapshot().secondary?.usedPercent).toBe(48)
      expect(feed.snapshot().observedAt).toBe(1_800_000_001_000)
      expect(onChange).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(5_000)
      expect(feed.snapshot().primary).toBeNull()
      expect(feed.snapshot().secondary?.usedPercent).toBe(48)
      vi.advanceTimersByTime(10_000)
      expect(feed.snapshot()).toEqual({ primary: null, secondary: null, observedAt: null })
      expect(onChange).toHaveBeenCalledTimes(4)
    } finally {
      feed.close()
    }
  })
})
