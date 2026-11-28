import { describe, expect, it } from 'vitest'
import { emptySnapshot } from '@qn/codex-client'
import {
  claudeRateLimitStatus,
  costFromNotification,
} from './claudeUsage'

const usage = (threadId: string, usd: number) => ({
  method: 'thread/tokenUsage/updated',
  params: { threadId, tokenUsage: { estimatedCostUsd: usd, estimated: true } },
})

describe('Claude 费用估算', () => {
  it('从 tokenUsage 通知提取 threadId 与估算费用', () => {
    expect(costFromNotification(usage('t1', 0.012))).toEqual({
      threadId: 't1',
      usd: 0.012,
      estimated: true,
    })
    expect(costFromNotification(usage('t1', 0))).toMatchObject({ usd: 0 })
    expect(costFromNotification({ method: 'turn/completed' })).toBeNull()
    expect(costFromNotification({ method: 'thread/tokenUsage/updated', params: {} })).toBeNull()
    expect(costFromNotification(null)).toBeNull()
  })

  it('徽标与详情展示限额事件和上限', () => {
    const empty = emptySnapshot()
    expect(claudeRateLimitStatus(empty)).toBe('等待 Claude CLI 上报')

    const snapshot = {
      ...empty,
      primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: null },
    }
    expect(claudeRateLimitStatus(snapshot)).toBe('上报剩余 10%')

    const reached = { ...snapshot, rateLimitReachedType: 'rate_limit_reached' as const }
    expect(claudeRateLimitStatus(reached)).toBe('已达额度上限')
  })
})
