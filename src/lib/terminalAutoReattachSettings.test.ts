// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GLOBAL_SETTINGS, stripGlobalOnlyKeys } from './projectSettings'
import {
  SESSION_AUTO_REATTACH_TERMINALS_KEY,
  TERMINAL_AUTO_REATTACH_CACHE_KEY,
  isTerminalAutoReattachEnabled,
  parseTerminalAutoReattach,
  readTerminalAutoReattach,
} from './terminalAutoReattachSettings'

describe('terminal auto-reattach setting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to on and only accepts booleans', () => {
    expect(DEFAULT_GLOBAL_SETTINGS[SESSION_AUTO_REATTACH_TERMINALS_KEY]).toBe(true)
    expect(parseTerminalAutoReattach(undefined)).toBe(true)
    expect(parseTerminalAutoReattach('off')).toBe(true)
    expect(parseTerminalAutoReattach(false)).toBe(false)
    expect(readTerminalAutoReattach({ [SESSION_AUTO_REATTACH_TERMINALS_KEY]: false })).toBe(false)
    expect(isTerminalAutoReattachEnabled()).toBe(true)
  })

  it('reads the cached value synchronously', () => {
    localStorage.setItem(TERMINAL_AUTO_REATTACH_CACHE_KEY, '0')
    expect(isTerminalAutoReattachEnabled()).toBe(false)
    localStorage.setItem(TERMINAL_AUTO_REATTACH_CACHE_KEY, '1')
    expect(isTerminalAutoReattachEnabled()).toBe(true)
  })

  it('is a user-scope setting only', () => {
    const stripped = stripGlobalOnlyKeys({ ...DEFAULT_GLOBAL_SETTINGS })
    expect(stripped[SESSION_AUTO_REATTACH_TERMINALS_KEY]).toBeUndefined()
  })
})
