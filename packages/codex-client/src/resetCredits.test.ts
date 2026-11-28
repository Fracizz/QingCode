import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexRpcLike } from './api'
import { createResetCreditRedeemer, pickResetCredits, resetCreditExpiry, unlistedResetCredits } from './resetCredits'

const credit = (id: string, extra: object = {}) => ({
  id, resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: null, title: null, description: null, ...extra,
})

function rpcOf(request: (...args: unknown[]) => Promise<unknown>) {
  const spy = vi.fn(request)
  return { spy, rpc: { request: spy } as unknown as CodexRpcLike }
}

afterEach(() => vi.useRealTimers())

describe('额度重置卡', () => {
  it('缺少字段时返回 null，只保留可用与使用中的卡并按过期时间排序', () => {
    expect(pickResetCredits({ rateLimitResetCredits: null })).toBeNull()
    expect(pickResetCredits({ rateLimits: {} })).toBeNull()
    const summary = pickResetCredits({ rateLimitResetCredits: { availableCount: 3, credits: [
      credit('forever'), credit('used', { status: 'redeemed' }),
      credit('soon', { expiresAt: 100, title: '赠送卡' }), credit('busy', { status: 'redeeming', expiresAt: 200 }),
    ] } })!
    expect(summary.credits.map((item) => item.id)).toEqual(['soon', 'busy', 'forever'])
    expect(summary.credits[0]?.title).toBe('赠送卡')
    expect(unlistedResetCredits(summary)).toBe(1)
  })

  it('只有张数时也能展示', () => {
    expect(pickResetCredits({ rateLimitResetCredits: { availableCount: 2, credits: null } }))
      .toEqual({ availableCount: 2, credits: [] })
  })

  it('过期时间说明', () => {
    expect(resetCreditExpiry(null)).toBe('长期有效')
    expect(resetCreditExpiry(1, 2000)).toBe('已过期')
    expect(resetCreditExpiry(2_000_000_000, 0)).toContain('有效期至')
  })

  it('结果未知时重试沿用幂等键，得到结果后换新键', async () => {
    let next = 0
    const redeem = createResetCreditRedeemer(() => `key-${++next}`)
    let fail = true
    const { spy, rpc } = rpcOf(async () => {
      if (fail) throw new Error('连接中断')
      return { outcome: 'reset' }
    })
    await expect(redeem(rpc, 'local', 'a')).resolves.toMatchObject({ tone: 'danger' })
    fail = false
    await expect(redeem(rpc, 'local', 'a')).resolves.toMatchObject({ tone: 'ok' })
    await redeem(rpc, 'local', 'a')
    await redeem(rpc, 'local', null)
    expect(spy.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: 'key-1', creditId: 'a' },
      { idempotencyKey: 'key-1', creditId: 'a' },
      { idempotencyKey: 'key-2', creditId: 'a' },
      { idempotencyKey: 'key-3' },
    ])
  })

  it('长时间没有回包时结束等待', async () => {
    vi.useFakeTimers()
    const redeem = createResetCreditRedeemer(() => 'key')
    const { rpc } = rpcOf(() => new Promise(() => undefined))
    const pending = redeem(rpc, 'local', null)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pending).resolves.toMatchObject({ tone: 'danger', text: expect.stringContaining('等待结果超时') })
  })
})
