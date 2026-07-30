import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECT_INDICATORS_CACHE_KEY,
  isProjectIndicatorsEnabled,
  parseProjectIndicatorsEnabled,
} from './projectIndicatorSettings'

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

describe('projectIndicatorSettings', () => {
  it('defaults to enabled when cache is empty', () => {
    expect(isProjectIndicatorsEnabled()).toBe(true)
    expect(parseProjectIndicatorsEnabled(undefined)).toBe(true)
    expect(parseProjectIndicatorsEnabled(false)).toBe(false)
  })

  it('reads localStorage cache for sync checks', () => {
    localStorage.setItem(PROJECT_INDICATORS_CACHE_KEY, '0')
    expect(isProjectIndicatorsEnabled()).toBe(false)
    localStorage.setItem(PROJECT_INDICATORS_CACHE_KEY, '1')
    expect(isProjectIndicatorsEnabled()).toBe(true)
  })
})
