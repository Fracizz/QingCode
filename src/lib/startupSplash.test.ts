import { describe, expect, it } from 'vitest'
import {
  STARTUP_SPLASH_ENTRANCE_MS,
  STARTUP_SPLASH_MIN_VISIBLE_MS,
  computeSplashDismissWait,
} from './startupSplash'

describe('computeSplashDismissWait', () => {
  it('waits until the minimum visible duration on fast boots', () => {
    expect(computeSplashDismissWait(0)).toBe(STARTUP_SPLASH_MIN_VISIBLE_MS)
    expect(computeSplashDismissWait(120)).toBe(STARTUP_SPLASH_MIN_VISIBLE_MS - 120)
  })

  it('does not add extra delay once the minimum has elapsed', () => {
    expect(computeSplashDismissWait(STARTUP_SPLASH_MIN_VISIBLE_MS)).toBe(0)
    expect(computeSplashDismissWait(STARTUP_SPLASH_MIN_VISIBLE_MS + 200)).toBe(0)
  })

  it('keeps minimum above entrance animation duration', () => {
    expect(STARTUP_SPLASH_MIN_VISIBLE_MS).toBeGreaterThan(STARTUP_SPLASH_ENTRANCE_MS)
  })
})
