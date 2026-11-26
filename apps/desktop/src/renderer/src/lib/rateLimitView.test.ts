import { describe, expect, it } from 'vitest'
import {
  notificationKind,
  severityBarClass,
  severityTextClass,
  updatedAtText,
} from './rateLimitView'

describe('额度界面纯逻辑', () => {
  it('识别需要处理的通知', () => {
    expect(notificationKind({ method: 'account/rateLimits/updated', params: {} })).toBe('updated')
    expect(notificationKind({ method: 'turn/completed', params: {} })).toBe('turnCompleted')
    expect(notificationKind({ method: 'thread/tokenUsage/updated', params: {} })).toBe('tokenUsage')
    expect(notificationKind({ method: 'turn/started' })).toBeNull()
    expect(notificationKind(null)).toBeNull()
    expect(notificationKind('turn/completed')).toBeNull()
  })

  it('阈值对应配色类', () => {
    expect(severityTextClass('ok')).toContain('qn-muted')
    expect(severityTextClass('warn')).toContain('amber')
    expect(severityTextClass('danger')).toContain('qn-danger')
    expect(severityBarClass('ok')).toBe('bg-qn-accent')
    expect(severityBarClass('warn')).toBe('bg-amber-400')
    expect(severityBarClass('danger')).toBe('bg-qn-danger')
  })

  it('最后更新时间按本地日历显示', () => {
    const now = new Date(2026, 0, 2, 16, 27, 0).getTime()
    expect(updatedAtText(new Date(2026, 0, 2, 15, 4, 5).getTime(), now)).toBe('最后更新 15:04:05')
    expect(updatedAtText(new Date(2026, 0, 1, 23, 0, 1).getTime(), now)).toBe(
      '最后更新 1月1日 23:00:01',
    )
    expect(updatedAtText(null, now)).toBe('尚未更新')
    expect(updatedAtText(Number.NaN, now)).toBe('尚未更新')
  })
})
