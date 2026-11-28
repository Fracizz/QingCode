import { describe, expect, it } from 'vitest'
import { nextScheduleAt, parseCadence } from './cadence'

const next = (rule: unknown, after: string) => new Date(nextScheduleAt(parseCadence(rule)!, Date.parse(after))).toISOString()

describe('定时规则', () => {
  it('墙钟时刻由任务时区决定，周末与已触发的时刻跳过', () => {
    expect(next({ frequency: 'weekdays', time: '09:00', timeZone: 'Asia/Shanghai' }, '2026-11-27T01:00:00Z'))
      .toBe('2026-11-30T01:00:00.000Z')
    expect(next({ frequency: 'weekly', time: '18:15', timeZone: 'Asia/Kathmandu', weekday: 6 }, '2026-11-27T00:00:00Z'))
      .toBe('2026-11-28T12:30:00.000Z')
  })

  it('夏令时缺失的时刻跳过，重复的时刻只触发一次', () => {
    const rule = { frequency: 'daily', time: '02:30', timeZone: 'America/Los_Angeles' }
    expect(next(rule, '2026-03-08T00:00:00Z')).toBe('2026-03-09T09:30:00.000Z')
    expect(next({ ...rule, time: '01:30' }, '2026-11-01T07:00:00Z')).toBe('2026-11-01T08:30:00.000Z')
    expect(next({ ...rule, time: '01:30' }, '2026-11-01T08:30:00Z')).toBe('2026-11-02T09:30:00.000Z')
  })

  it('拒绝无效时间、时区和星期', () => {
    const rule = { frequency: 'weekly', time: '09:00', timeZone: 'UTC', weekday: 2 }
    for (const patch of [{ time: '24:00' }, { timeZone: 'invalid' }, { weekday: 7 }]) {
      expect(parseCadence({ ...rule, ...patch })).toBeNull()
    }
  })
})
