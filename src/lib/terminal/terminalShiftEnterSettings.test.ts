import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBAL_SETTINGS } from '@/lib/projectSettings'
import {
  parseTerminalShiftEnterNewline,
  readTerminalShiftEnterNewline,
  SHIFT_ENTER_NEWLINE_KEY,
} from './terminalShiftEnterSettings'

describe('terminal Shift+Enter newline setting', () => {
  it('is on unless explicitly disabled', () => {
    expect(parseTerminalShiftEnterNewline(undefined)).toBe(true)
    expect(parseTerminalShiftEnterNewline(true)).toBe(true)
    expect(parseTerminalShiftEnterNewline(false)).toBe(false)
  })

  it('reads terminal.integrated.shiftEnterNewline and defaults to enabled', () => {
    expect(readTerminalShiftEnterNewline({ [SHIFT_ENTER_NEWLINE_KEY]: false })).toBe(false)
    expect(readTerminalShiftEnterNewline(DEFAULT_GLOBAL_SETTINGS)).toBe(true)
  })
})
