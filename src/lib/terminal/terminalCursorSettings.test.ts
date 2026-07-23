import { describe, expect, it } from 'vitest'
import {
  parseTerminalCursorBlinking,
  readTerminalCursorBlinking,
} from '@/lib/terminal/terminalCursorSettings'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'

describe('terminalCursorSettings', () => {
  it('defaults to blinking when unset', () => {
    expect(parseTerminalCursorBlinking(undefined)).toBe(true)
    expect(parseTerminalCursorBlinking(false)).toBe(false)
    expect(parseTerminalCursorBlinking(true)).toBe(true)
  })

  it('reads terminal.integrated.cursorBlinking', () => {
    expect(
      readTerminalCursorBlinking({
        ...DEFAULT_GLOBAL_SETTINGS,
        'terminal.integrated.cursorBlinking': false,
      }),
    ).toBe(false)
    expect(readTerminalCursorBlinking(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
  })
})
