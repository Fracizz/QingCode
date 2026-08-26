import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_REFRESH_INTERVAL_START_CACHE_KEY,
  MAX_GIT_REFRESH_INTERVAL_START_MINUTES,
  getGitRefreshIntervalStartMinutes,
  parseGitRefreshIntervalStartMinutes,
  readGitRefreshIntervalStartMinutes,
} from './gitRefreshSettings'
import { GIT_REFRESH_INTERVAL_START_MINUTES_KEY } from './projectSettings'

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

describe('gitRefreshSettings', () => {
  it('defaults to 5 minutes and clamps values to whole-minute bounds', () => {
    expect(parseGitRefreshIntervalStartMinutes(undefined)).toBe(5)
    expect(parseGitRefreshIntervalStartMinutes(1)).toBe(5)
    expect(parseGitRefreshIntervalStartMinutes(8.6)).toBe(9)
    expect(parseGitRefreshIntervalStartMinutes(MAX_GIT_REFRESH_INTERVAL_START_MINUTES + 1)).toBe(
      MAX_GIT_REFRESH_INTERVAL_START_MINUTES
    )
  })

  it('reads the configured value and synchronous cache', () => {
    expect(
      readGitRefreshIntervalStartMinutes({
        [GIT_REFRESH_INTERVAL_START_MINUTES_KEY]: 12,
      })
    ).toBe(12)
    localStorage.setItem(GIT_REFRESH_INTERVAL_START_CACHE_KEY, '18')
    expect(getGitRefreshIntervalStartMinutes()).toBe(18)
  })
})
