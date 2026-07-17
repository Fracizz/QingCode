import { describe, expect, it } from 'vitest'
import {
  parseTerminalCursorBlinking,
  readTerminalCursorBlinking,
} from './terminalCursorSettings'

describe('terminalCursorSettings', () => {
  it('defaults to blinking when unset', () => {
    expect(parseTerminalCursorBlinking(undefined)).toBe(true)
    expect(parseTerminalCursorBlinking(false)).toBe(false)
    expect(parseTerminalCursorBlinking(true)).toBe(true)
  })

  it('reads terminal.integrated.cursorBlinking', () => {
    expect(readTerminalCursorBlinking({ 'terminal.integrated.cursorBlinking': false })).toBe(
      false,
    )
    expect(readTerminalCursorBlinking({})).toBe(true)
  })
})
