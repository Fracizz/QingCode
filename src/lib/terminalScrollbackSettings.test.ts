import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  parseTerminalScrollback,
  readTerminalScrollback,
  scrollbackMaxChars,
} from './terminalScrollbackSettings'
import { DEFAULT_GLOBAL_SETTINGS } from './projectSettings'

describe('parseTerminalScrollback', () => {
  it('falls back and clamps', () => {
    expect(parseTerminalScrollback(undefined)).toBe(DEFAULT_TERMINAL_SCROLLBACK)
    expect(parseTerminalScrollback('nope')).toBe(DEFAULT_TERMINAL_SCROLLBACK)
    expect(parseTerminalScrollback(10)).toBe(MIN_TERMINAL_SCROLLBACK)
    expect(parseTerminalScrollback(999_999)).toBe(MAX_TERMINAL_SCROLLBACK)
    expect(parseTerminalScrollback(2500)).toBe(2500)
  })

  it('reads from settings file', () => {
    expect(readTerminalScrollback(DEFAULT_GLOBAL_SETTINGS)).toBe(DEFAULT_TERMINAL_SCROLLBACK)
    expect(
      readTerminalScrollback({
        ...DEFAULT_GLOBAL_SETTINGS,
        'terminal.integrated.scrollback': 1200,
      }),
    ).toBe(1200)
  })

  it('derives a bounded char budget from line count', () => {
    expect(scrollbackMaxChars(100)).toBeGreaterThanOrEqual(8 * 1024)
    expect(scrollbackMaxChars(100_000)).toBeLessThanOrEqual(512 * 1024)
  })
})
