import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyMotionPreference,
  loadMotionPreference,
  motionReduced,
  preferredScrollBehavior,
  saveMotionPreference,
} from './motionPreferences'

afterEach(() => vi.unstubAllGlobals())
describe('preferredScrollBehavior', () => {
  it('disables JS smooth scrolling when reduced motion is requested', () => {
    const matchMedia = vi.fn(() => ({ matches: true }))
    vi.stubGlobal('window', { matchMedia })
    expect(preferredScrollBehavior()).toBe('auto')
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })
  it('rechecks the preference instead of caching it across system changes', () => {
    const matchMedia = vi.fn().mockReturnValueOnce({ matches: false }).mockReturnValueOnce({ matches: true })
    vi.stubGlobal('window', { matchMedia })
    expect(preferredScrollBehavior()).toBe('smooth')
    expect(preferredScrollBehavior()).toBe('auto')
  })
  it('works when window or matchMedia are unavailable', () => {
    vi.stubGlobal('window', undefined)
    expect(preferredScrollBehavior()).toBe('smooth')
    vi.stubGlobal('window', {})
    expect(preferredScrollBehavior()).toBe('smooth')
  })
})

describe('motion preference', () => {
  function memoryStorage() {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      removeItem: (key: string) => { data.delete(key) },
    }
  }

  it('in-app reduce wins even when the system allows motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal('document', { documentElement: { dataset: { motion: 'reduce' } } })
    expect(motionReduced()).toBe(true)
    expect(preferredScrollBehavior()).toBe('auto')
  })

  it('following the system cannot force motion back on', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    vi.stubGlobal('document', { documentElement: { dataset: {} } })
    expect(motionReduced()).toBe(true)
  })

  it('saves, loads and applies the preference to html[data-motion]', () => {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('document', { documentElement: { dataset } })
    expect(loadMotionPreference()).toBe('system')
    saveMotionPreference('reduce')
    expect(loadMotionPreference()).toBe('reduce')
    expect(dataset.motion).toBe('reduce')
    saveMotionPreference('system')
    expect(loadMotionPreference()).toBe('system')
    expect(dataset.motion).toBeUndefined()
    applyMotionPreference('reduce')
    expect(dataset.motion).toBe('reduce')
  })

  it('treats unreadable storage as following the system', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') } })
    expect(loadMotionPreference()).toBe('system')
  })
})
