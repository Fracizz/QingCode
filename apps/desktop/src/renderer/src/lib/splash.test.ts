import { describe, expect, it } from 'vitest'
import {
  SPLASH_MIN_VISIBLE_MS,
  SPLASH_REDUCED_MIN_VISIBLE_MS,
  bootPhaseText,
  splashDismissDelay,
} from './splash'

describe('splashDismissDelay', () => {
  it('不足最短展示时补足剩余时间', () => {
    expect(splashDismissDelay(200)).toBe(SPLASH_MIN_VISIBLE_MS - 200)
  })

  it('已超过最短展示时立即淡出', () => {
    expect(splashDismissDelay(SPLASH_MIN_VISIBLE_MS + 500)).toBe(0)
  })

  it('减少动态效果时使用更短的展示时间', () => {
    expect(splashDismissDelay(0, { reducedMotion: true })).toBe(SPLASH_REDUCED_MIN_VISIBLE_MS)
  })

  it('smoke 模式不等待', () => {
    expect(splashDismissDelay(0, { smoke: true })).toBe(0)
  })

  it('异常的耗时按刚启动处理', () => {
    expect(splashDismissDelay(Number.NaN)).toBe(SPLASH_MIN_VISIBLE_MS)
    expect(splashDismissDelay(-5)).toBe(SPLASH_MIN_VISIBLE_MS)
  })
})

describe('bootPhaseText', () => {
  it('每个阶段都有中文提示', () => {
    expect(bootPhaseText('backend')).toContain('后台')
    expect(bootPhaseText('targets')).toContain('连接')
    expect(bootPhaseText('ready')).toBe('准备就绪')
  })
})
