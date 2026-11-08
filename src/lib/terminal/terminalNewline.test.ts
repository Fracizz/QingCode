import { describe, expect, it } from 'vitest'
import {
  isTerminalAgentForeground,
  isTerminalNewlineShortcut,
  isTerminalShiftNewlineShortcut,
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

  it('matches only unmodified Shift+Enter for the Agent newline', () => {
    const shift = { ctrlKey: false, shiftKey: true }
    expect(isTerminalShiftNewlineShortcut(event(shift))).toBe(true)
    expect(isTerminalShiftNewlineShortcut(event({ ...shift, type: 'keyup' }))).toBe(false)
    expect(isTerminalShiftNewlineShortcut(event({ ...shift, ctrlKey: true }))).toBe(false)
    expect(isTerminalShiftNewlineShortcut(event({ ...shift, altKey: true }))).toBe(false)
    expect(isTerminalShiftNewlineShortcut(event({ ctrlKey: false }))).toBe(false)
  })
})

describe('terminal Agent foreground detection', () => {
  const shell = {
    alternateBuffer: false,
    mouseTracking: false,
    focusReporting: false,
    title: 'PowerShell',
    commandRunning: null,
  }

  it('leaves a plain shell alone', () => {
    expect(isTerminalAgentForeground(shell)).toBe(false)
    expect(isTerminalAgentForeground({ ...shell, title: '' })).toBe(false)
    expect(isTerminalAgentForeground({ ...shell, commandRunning: true })).toBe(false)
  })

  it('trusts terminal modes even when shell integration still reports a prompt', () => {
    for (const mode of ['alternateBuffer', 'mouseTracking', 'focusReporting']) {
      expect(isTerminalAgentForeground({ ...shell, [mode]: true, commandRunning: false })).toBe(true)
    }
  })

  it.each(['✳ Claude Code', '✳ Fix login bug', '⠋ Fix login bug', 'codex', 'OpenCode'])(
    'recognizes the Agent title %s',
    title => {
      expect(isTerminalAgentForeground({ ...shell, title })).toBe(true)
    },
  )

  it('ignores a stale Agent title once the shell reports a prompt', () => {
    expect(isTerminalAgentForeground({ ...shell, title: '✳ Claude Code', commandRunning: false })).toBe(false)
  })

  it('does not match words that merely contain an Agent name', () => {
    expect(isTerminalAgentForeground({ ...shell, title: 'claudette-dev' })).toBe(false)
    expect(isTerminalAgentForeground({ ...shell, title: 'mycodexfile' })).toBe(false)
  })
})
