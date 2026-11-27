import { describe, expect, it } from 'vitest'
import { emptySnapshot } from '@qn/codex-client'
import {
  claudeCompactText,
  claudeRateLimitStatus,
  costFromNotification,
  formatCost,
  sumCost,
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

  it('按会话汇总，金额格式化保留有效小数', () => {
    expect(sumCost({ t1: 0.01, t2: 0.5 })).toBeCloseTo(0.51)
    expect(sumCost({ t1: 0.01, t2: 0.5 }, 't1')).toBeCloseTo(0.01)
    expect(sumCost(undefined, 't1')).toBe(0)
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.0012)).toBe('$0.0012')
    expect(formatCost(0.012)).toBe('$0.012')
    expect(formatCost(1.2345)).toBe('$1.23')
  })

  it('徽标与详情展示限额事件、上限和估算标记', () => {
    const empty = emptySnapshot()
    expect(claudeRateLimitStatus(empty)).toBe('等待 Claude CLI 上报')
    expect(claudeCompactText(empty, 0.01)).toBe('等待 Claude CLI 上报 · ≈$0.01（估算）')

    const snapshot = {
      ...empty,
      primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: null },
    }
    expect(claudeRateLimitStatus(snapshot)).toBe('上报剩余 10%')
    expect(claudeCompactText(snapshot, 0.012)).toBe('上报剩余 10% · ≈$0.012（估算）')

    const reached = { ...snapshot, rateLimitReachedType: 'rate_limit_reached' as const }
    expect(claudeRateLimitStatus(reached)).toBe('已达额度上限')
    expect(claudeCompactText(reached, 0)).toBe('已达额度上限')
  })
})
