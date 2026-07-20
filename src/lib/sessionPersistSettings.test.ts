import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_PERSIST_CACHE_KEY,
  isSessionPersistEnabled,
  parseSessionPersist,
} from './sessionPersistSettings'

function installMemoryLocalStorage() {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  })
}

beforeEach(() => {
  installMemoryLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sessionPersistSettings', () => {
  it('defaults to enabled when cache is empty', () => {
    expect(isSessionPersistEnabled()).toBe(true)
    expect(parseSessionPersist(undefined)).toBe(true)
    expect(parseSessionPersist(false)).toBe(false)
  })

  it('reads localStorage cache for sync boot checks', () => {
    localStorage.setItem(SESSION_PERSIST_CACHE_KEY, '0')
    expect(isSessionPersistEnabled()).toBe(false)
    localStorage.setItem(SESSION_PERSIST_CACHE_KEY, '1')
    expect(isSessionPersistEnabled()).toBe(true)
  })
})
