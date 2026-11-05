import { describe, expect, it } from 'vitest'
import {
  isTerminalNewlineShortcut,
  TERMINAL_NEWLINE_INPUT,
} from './terminalNewline'

const event = (overrides: Partial<Parameters<typeof isTerminalNewlineShortcut>[0]> = {}) => ({
  type: 'keydown',
  key: 'Enter',
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
})

describe('terminal newline shortcut', () => {
  it('uses LF so Ctrl+Enter does not submit with CR', () => {
    expect(TERMINAL_NEWLINE_INPUT).toBe('\n')
  })

  it('matches Ctrl+Enter and Cmd+Enter on keydown only', () => {
    expect(isTerminalNewlineShortcut(event())).toBe(true)
    expect(isTerminalNewlineShortcut(event({ ctrlKey: false, metaKey: true }))).toBe(true)
    expect(isTerminalNewlineShortcut(event({ type: 'keyup' }))).toBe(false)
  })

  it('leaves plain, shifted, and alt-modified Enter to the terminal', () => {
    expect(isTerminalNewlineShortcut(event({ ctrlKey: false }))).toBe(false)
    expect(isTerminalNewlineShortcut(event({ shiftKey: true }))).toBe(false)
    expect(isTerminalNewlineShortcut(event({ altKey: true }))).toBe(false)
    expect(isTerminalNewlineShortcut(event({ key: 'NumpadEnter' }))).toBe(false)
  })
})
