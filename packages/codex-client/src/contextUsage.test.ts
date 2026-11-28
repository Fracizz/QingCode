import { describe, expect, it } from 'vitest'
import { contextUsage, estimatedTurnUsage } from './contextUsage'

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

describe('单轮用量', () => {
  it('可读取无上下文大小的单轮统计，不带出费用', () => {
    const usage = { estimated: true, modelContextWindow: null, last: { totalTokens: 128 }, estimatedCostUsd: 0 }
    expect(contextUsage(usage)).toBeNull()
    expect(estimatedTurnUsage(usage)).toEqual({ tokens: 128 })
  })

  it('忽略标准上下文统计和无效字段', () => {
    expect(estimatedTurnUsage({ last: { totalTokens: 10 } })).toBeNull()
    expect(estimatedTurnUsage({ estimated: true, last: { totalTokens: -1 }, estimatedCostUsd: Infinity })).toBeNull()
    expect(estimatedTurnUsage({ estimated: true, last: { totalTokens: 5 } })).toEqual({ tokens: 5 })
  })
})
