import { afterEach, describe, expect, it, vi } from 'vitest'
import { preferredScrollBehavior } from './motionPreferences'

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
