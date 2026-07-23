import { describe, expect, it } from 'vitest'
import {
  getTerminalPtyResizeDelay,
  isValidTerminalGridSize,
  terminalGridSizeChanged,
  TERMINAL_ALTERNATE_PTY_DELAY_MS,
  TERMINAL_NORMAL_PTY_DELAY_MS,
} from '@/lib/terminal/terminalResizePolicy'

describe('terminal resize policy', () => {
  it('only accepts usable character grids', () => {
    expect(isValidTerminalGridSize({ cols: 80, rows: 24 })).toBe(true)
    expect(isValidTerminalGridSize({ cols: 1, rows: 24 })).toBe(false)
    expect(isValidTerminalGridSize({ cols: 80, rows: 0 })).toBe(false)
  })

  it('detects row and column changes independently of pixel changes', () => {
    expect(terminalGridSizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(true)
    expect(terminalGridSizeChanged({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(true)
    expect(terminalGridSizeChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false)
  })

  it('uses a shorter PTY merge window for alternate-screen applications', () => {
    expect(getTerminalPtyResizeDelay('alternate')).toBe(TERMINAL_ALTERNATE_PTY_DELAY_MS)
    expect(getTerminalPtyResizeDelay('normal')).toBe(TERMINAL_NORMAL_PTY_DELAY_MS)
  })
})
