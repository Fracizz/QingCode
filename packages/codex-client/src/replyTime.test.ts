import { expect, it } from 'vitest'
import { formatReplyTime, localReplyDay } from './replyTime'

it('按设备本地日历区别当天、跨午夜和跨年', () => {
  const today = localReplyDay(new Date(2026, 0, 1, 0, 15).getTime())
  const midnight = new Date(2026, 0, 1, 0, 0)
  expect(formatReplyTime(midnight.getTime(), today)).toEqual({
    label: '00:00', full: '2026-01-01 00:00', dateTime: midnight.toISOString(),
  })
  expect(formatReplyTime(new Date(2025, 11, 31, 23, 59).getTime(), today)?.label).toBe('2025-12-31 23:59')
  expect(formatReplyTime(Number.NaN, today)).toBeNull()
})
