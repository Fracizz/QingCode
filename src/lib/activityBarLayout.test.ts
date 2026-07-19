import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_BAR_HIDDEN_KEY,
  loadActivityBarHidden,
  saveActivityBarHidden,
} from './activityBarLayout'

describe('activityBarLayout', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to visible', () => {
    expect(loadActivityBarHidden()).toBe(false)
  })

  it('persists hidden state', () => {
    saveActivityBarHidden(true)
    expect(loadActivityBarHidden()).toBe(true)
    expect(store.get(ACTIVITY_BAR_HIDDEN_KEY)).toBe('1')
    saveActivityBarHidden(false)
    expect(loadActivityBarHidden()).toBe(false)
  })
})
