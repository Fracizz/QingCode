import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWebTest } from './webTestMode'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Web test activation boundary', () => {
  it('requires an explicit development mode and never replaces a native runtime', () => {
    vi.stubGlobal('isTauri', false)
    vi.stubEnv('DEV', true)
    vi.stubEnv('MODE', 'development')
    expect(isWebTest()).toBe(false)
    vi.stubEnv('MODE', 'web-test')
    expect(isWebTest()).toBe(true)
    vi.stubGlobal('isTauri', true)
    expect(isWebTest()).toBe(false)
    vi.stubGlobal('isTauri', false)
    vi.stubEnv('DEV', false)
    expect(isWebTest()).toBe(false)
  })
})
