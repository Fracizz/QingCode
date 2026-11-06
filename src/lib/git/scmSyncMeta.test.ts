import { describe, expect, it } from 'vitest'
import { shouldAutoFetch } from '@/lib/git/scmSyncMeta'

describe('scmSyncMeta', () => {
  it('allows first fetch on project switch', () => {
    expect(shouldAutoFetch(null, false, 'switch-project', true)).toBe(true)
  })

  it('throttles enter-scm within two minutes', () => {
    expect(shouldAutoFetch(Date.now() - 30_000, false, 'enter-scm', true)).toBe(false)
  })

  it('allows window-focus after five minutes', () => {
    expect(shouldAutoFetch(Date.now() - 6 * 60_000, false, 'window-focus', true)).toBe(true)
  })

  it('throttles project switch after a recent failed auto fetch attempt', () => {
    const attemptAt = Date.now() - 30_000
    expect(shouldAutoFetch(null, false, 'switch-project', true, attemptAt)).toBe(false)
    expect(shouldAutoFetch(null, false, 'enter-scm', true, attemptAt)).toBe(false)
    expect(shouldAutoFetch(null, false, 'manual', true, attemptAt)).toBe(true)
  })

  it('allows auto fetch again once the failed attempt is older than the interval', () => {
    const attemptAt = Date.now() - 3 * 60_000
    expect(shouldAutoFetch(null, false, 'switch-project', true, attemptAt)).toBe(true)
  })

  it('skips auto fetch after auth failure', () => {
    expect(shouldAutoFetch(null, true, 'enter-scm', true)).toBe(false)
    expect(shouldAutoFetch(null, true, 'push-failed-behind', true)).toBe(true)
  })
})
