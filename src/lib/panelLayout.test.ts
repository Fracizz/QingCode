import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampTerminalWidth,
  getTerminalMaxWidth,
  TERMINAL_MIN_WIDTH,
} from './panelLayout'

beforeEach(() => {
  vi.stubGlobal('window', { innerWidth: 1400 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampTerminalWidth', () => {
  it('clamps to min and max for a typical window', () => {
    expect(clampTerminalWidth(50)).toBe(TERMINAL_MIN_WIDTH)
    expect(clampTerminalWidth(400)).toBe(400)
    expect(clampTerminalWidth(2000)).toBe(getTerminalMaxWidth())
  })
})
