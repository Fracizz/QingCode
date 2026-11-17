// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { heroCollapsed } from '../../mobile/android/web/heroHeader.js'
import { pendingSessions, updateSessionAttention } from '../../mobile/android/web/protocol.js'

const session = (id: string, busy: boolean, extra: Record<string, unknown> = {}) => ({ id, programBusy: busy, ...extra })

describe('Android 首页待处理', () => {
  it('只列出有新结果的会话，最近有活动的在前，缺少活动时间的排最后', () => {
    const list = [
      session('old', false, { lastActiveAt: 100 }),
      session('none', false),
      session('new', false, { lastActiveAt: 300 }),
      session('seen', false, { lastActiveAt: 500 }),
    ]
    const attention = new Set(['old', 'none', 'new'])
    expect(pendingSessions(list, attention).map(item => item.id)).toEqual(['new', 'old', 'none'])
    expect(pendingSessions(null, attention)).toEqual([])
  })

  it('首页不显示终端：会话从运行转为停下（含退出）即进入待处理，重新运行时移出', () => {
    const tracker = { busy: new Set<string>(), attention: new Set<string>() }
    updateSessionAttention(tracker, [session('a', true), session('b', true)], null)
    updateSessionAttention(tracker, [session('a', false), session('b', false, { exit: { code: 0 } })], null)
    expect(pendingSessions([session('a', false), session('b', false)], tracker.attention).map(item => item.id).sort()).toEqual(['a', 'b'])
    updateSessionAttention(tracker, [session('a', true)], null)
    expect(tracker.attention.has('a')).toBe(false)
  })
})

describe('Android 工作台大标题收起', () => {
  it('滚过大标题底边（留少量余量）才收起', () => {
    expect(heroCollapsed(0, 120)).toBe(false)
    expect(heroCollapsed(112, 120)).toBe(false)
    expect(heroCollapsed(113, 120)).toBe(true)
    expect(heroCollapsed(1, 0)).toBe(true)
  })
})

describe('Android 待处理时间', () => {
  it('按最近活动显示相对时间，缺少活动时间时为空', async () => {
    const { pendingTime } = await import('../../mobile/android/web/protocol.js')
    const now = 10 * 24 * 3600e3
    expect(pendingTime({ lastActiveAt: now - 30e3 }, now)).toBe('刚刚')
    expect(pendingTime({ lastActiveAt: now - 5 * 60e3 }, now)).toBe('5 分钟前')
    expect(pendingTime({ lastActiveAt: now - 3 * 3600e3 }, now)).toBe('3 小时前')
    expect(pendingTime({ lastActiveAt: now - 2 * 24 * 3600e3 }, now)).toBe('2 天前')
    expect(pendingTime({}, now)).toBe('')
    // 旧版电脑端给电脑终端填 0：不能显示成「20774 天前」
    expect(pendingTime({ lastActiveAt: 0 }, now)).toBe('')
    expect(pendingTime({ lastActiveAt: null }, now)).toBe('')
  })
})
