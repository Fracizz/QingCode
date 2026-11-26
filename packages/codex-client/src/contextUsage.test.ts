import { describe, expect, it } from 'vitest'
import { contextUsage } from './contextUsage'

describe('上下文占用', () => {
  it('使用最近一轮 token 数，百分比上限为 100', () => {
    expect(contextUsage({ modelContextWindow: 100, last: { totalTokens: 25 }, total: { totalTokens: 500 } })).toEqual({ percent: 25, used: 25, window: 100 })
    expect(contextUsage({ modelContextWindow: 100, last: { totalTokens: 500 } })?.percent).toBe(100)
  })

  it('缺少完整用量时不显示占用', () => {
    expect(contextUsage({ modelContextWindow: null, last: { totalTokens: 0 } })).toBeNull()
    expect(contextUsage({ modelContextWindow: 100, last: {} })).toBeNull()
    expect(contextUsage({ modelContextWindow: Infinity, last: { totalTokens: 10 } })).toBeNull()
  })
})
