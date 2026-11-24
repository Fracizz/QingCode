import { describe, expect, it } from 'vitest'
import { hasPrewarmTarget, prewarmBadgeDetails, prewarmBadges } from './prewarmBadge'

const translate = (key: string, params?: Record<string, string | number>) =>
  key.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))

describe('prewarmBadge', () => {
  it('预热关闭或未受信任时不显示', () => {
    expect(prewarmBadges(null)).toEqual([])
    expect(prewarmBadges({ target: 0, ready: 0, reason: 'untrusted' })).toEqual([])
    expect(hasPrewarmTarget({ target: 0, ready: 0, reason: 'no_target' })).toBe(false)
  })

  it('没设 CLI 时显示普通 Shell 池，按就绪情况区分补满与补充中', () => {
    expect(prewarmBadges({ target: 2, ready: 2, reason: null })).toEqual([{
      pool: 'shell', ready: 2, target: 2, tone: 'full', reason: null,
    }])
    expect(prewarmBadges({ target: 2, ready: 1, preparing: 1, reason: null })[0].tone).toBe('filling')
  })

  it('设了 CLI 时 Shell 与 CLI 池各一枚，各自着色、暂停原因优先', () => {
    const status = { target: 2, ready: 2, reason: null, profile: { target: 1, ready: 0, reason: 'profile_exited' } }
    expect(hasPrewarmTarget({ target: 0, profile: { target: 1 } })).toBe(true)
    expect(prewarmBadges(status)).toEqual([
      { pool: 'shell', ready: 2, target: 2, tone: 'full', reason: null },
      { pool: 'cli', ready: 0, target: 1, tone: 'paused', reason: 'profile_exited' },
    ])
    // 普通 Shell 设为不预热时只剩 CLI 池。
    expect(prewarmBadges({ ...status, target: 0 }).map(b => b.pool)).toEqual(['cli'])
  })

  it('悬停详情列出两个池和最近的领取情况', () => {
    const details = prewarmBadgeDetails(
      { target: 2, ready: 1, preparing: 1, reserved: 1, reason: null, profile: { target: 2, ready: 0, reason: 'profile_exited' } },
      { hit: 3, miss: 1, missReasons: { preparing: 1 } },
      translate,
    )
    expect(details.title).toBe('终端预热')
    expect(details.status).toEqual({ text: '已暂停', tone: 'warn' })
    expect(details.rows).toEqual([
      { label: 'Shell 预热', value: '就绪 1/2 · 准备中 · 已预留 1' },
      { label: 'CLI 预热', value: '就绪 0/2 · 暂停：profile_exited' },
      { label: '最近新建', value: '命中 3 · 未命中 1（preparing×1）' },
      { label: '操作', value: '双击重新触发预热' },
    ])
  })
})
