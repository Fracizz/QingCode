import { describe, expect, it } from 'vitest'
import {
  buildThread,
  buildTurn,
  emptyRateLimitsResponse,
  rateLimitSnapshot,
  tokenUsage,
  userMessageItem,
  type Json,
} from './v2'

describe('v2 形状构造', () => {
  it('Thread 补齐 vendor 必填字段，秒级时间戳与 cwd 一致', () => {
    const thread = buildThread({ id: 's1', cwd: '/work', createdAt: 100, updatedAt: 200, preview: '摘要' })
    expect(thread).toMatchObject({
      id: 's1',
      sessionId: 's1',
      preview: '摘要',
      cwd: '/work',
      createdAt: 100,
      updatedAt: 200,
      status: { type: 'idle' },
      modelProvider: 'anthropic',
      historyMode: 'legacy',
      turns: [],
      forkedFromId: null,
      parentThreadId: null,
    })
  })

  it('Thread 可以带上当前生效的模型/推理强度', () => {
    const thread = buildThread({ id: 's1', cwd: '/work' }, [], { model: 'opus', reasoningEffort: 'high' })
    expect(thread).toMatchObject({ model: 'opus', reasoningEffort: 'high' })
    expect(buildThread({ id: 's2', cwd: '/work' })).toMatchObject({ model: null, reasoningEffort: null })
  })

  it('Turn 的 inProgress/failed 状态与 error 字段', () => {
    const active = buildTurn('t1', [userMessageItem('u1', 'hi')], 'inProgress')
    expect(active).toMatchObject({ id: 't1', status: 'inProgress', completedAt: null, error: null })
    expect((active.items as Json[])[0]?.type).toBe('userMessage')
    const failed = buildTurn('t2', [], 'failed', '出错了')
    expect(failed.error).toMatchObject({ message: '出错了' })
    expect(failed.status).toBe('failed')
  })

  it('无限额事件时 account/rateLimits/read 返回全 null 快照', () => {
    const response = emptyRateLimitsResponse()
    const snapshot = response.rateLimits as Json
    expect(snapshot.primary).toBeNull()
    expect(snapshot.secondary).toBeNull()
    expect(snapshot.limitId).toBeNull()
    expect(snapshot.limitName).toBeNull()
    expect(snapshot.rateLimitReachedType).toBeNull()
    expect((response.rateLimitsByLimitId as Json).claude).toEqual(snapshot)
    expect(rateLimitSnapshot()).toEqual(snapshot)
  })

  it('限额事件里有利用率与重置时间；rejected → rate_limit_reached', () => {
    const snapshot = rateLimitSnapshot({
      status: 'rejected',
      rateLimitType: 'seven_day',
      utilization: 1.05,
      resetsAt: 1_800_000_000_000,
    })
    expect(snapshot.primary).toEqual({
      usedPercent: 100,
      windowDurationMins: 10080,
      resetsAt: 1_800_000_000,
    })
    expect(snapshot.rateLimitReachedType).toBe('rate_limit_reached')
    expect(String(snapshot.limitName)).toContain('仅接近')
  })

  it('tokenUsage 汇总 token 并把成本标为估算', () => {
    const usage = tokenUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
      total_cost_usd: 0.5,
    })
    expect(usage.total).toEqual({
      totalTokens: 128,
      inputTokens: 108,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 3,
      outputTokens: 20,
      reasoningOutputTokens: 0,
    })
    expect(usage.estimatedCostUsd).toBe(0.5)
    expect(usage.estimated).toBe(true)
    expect(tokenUsage(null).total).toMatchObject({ totalTokens: 0 })
  })
})
