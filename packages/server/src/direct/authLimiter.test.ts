import { describe, expect, it } from 'vitest'
import { AuthLimiter } from './authLimiter'

describe('AuthLimiter', () => {
  it('locks after max failures and unlocks after lock period', () => {
    let now = 1_000
    const limiter = new AuthLimiter({ maxFailures: 3, lockMs: 500, now: () => now })
    limiter.fail('a')
    limiter.fail('a')
    expect(limiter.isLocked('a')).toBe(false)
    limiter.fail('a')
    expect(limiter.isLocked('a')).toBe(true)
    expect(limiter.isLocked('b')).toBe(false)
    now += 501
    expect(limiter.isLocked('a')).toBe(false)
  })

  it('success resets the counter', () => {
    const limiter = new AuthLimiter({ maxFailures: 2 })
    limiter.fail('a')
    limiter.succeed('a')
    limiter.fail('a')
    expect(limiter.isLocked('a')).toBe(false)
  })
})
