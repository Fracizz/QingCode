import { describe, expect, it } from 'vitest'
import { showsPrewarmHit, showsPrewarmPending } from './prewarmIndicator'

describe('prewarm indicator', () => {
  it('普通 Shell 领取预热 Shell 时显示命中', () => {
    expect(showsPrewarmHit({ prewarm: { outcome: 'hit' } })).toBe(true)
    expect(showsPrewarmHit({ prewarm: { outcome: 'hit' }, launchCommand: '  ' })).toBe(true)
  })

  it('带启动命令时只有 CLI 预热会话命中才显示', () => {
    expect(showsPrewarmHit({ prewarm: { outcome: 'hit' }, launchCommand: 'claude' })).toBe(false)
    expect(showsPrewarmHit({ prewarm: { outcome: 'hit', kind: 'profile' }, launchCommand: 'claude' })).toBe(true)
  })

  it('未命中或未预热不显示', () => {
    expect(showsPrewarmHit({ prewarm: { outcome: 'miss', reason: 'no_target' } })).toBe(false)
    expect(showsPrewarmHit({})).toBe(false)
  })

  it('接管中的指示遵循同样规则', () => {
    expect(showsPrewarmPending({ prewarm: { outcome: 'reserved' } })).toBe(true)
    expect(showsPrewarmPending({ prewarm: { outcome: 'reserved' }, launchCommand: 'claude' })).toBe(false)
    expect(showsPrewarmPending({ prewarm: { outcome: 'reserved', kind: 'profile' }, launchCommand: 'claude' })).toBe(true)
  })
})
