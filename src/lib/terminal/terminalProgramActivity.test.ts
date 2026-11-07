import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SPINNER_HOLD_MS,
  clearTerminalProgramActivity,
  isSpinnerFrame,
  isTerminalProgramBusy,
  noteTerminalTitle,
  subscribeTerminalProgramActivity,
} from './terminalProgramActivity'

describe('terminal program activity', () => {
  afterEach(() => {
    clearTerminalProgramActivity('t1')
    vi.useRealTimers()
  })

  it('recognizes known spinner glyphs and glyph-only title changes', () => {
    expect(isSpinnerFrame(null, '⠋ Claude Code')).toBe(true)
    expect(isSpinnerFrame(null, '✳ Claude Code')).toBe(false)
    expect(isSpinnerFrame('✳ Claude Code', '✶ Claude Code')).toBe(true)
    expect(isSpinnerFrame('✳ Claude Code', '✳ Other')).toBe(false)
    expect(isSpinnerFrame('build', 'test')).toBe(false)
  })

  it('stays running across gaps between frames, then notifies when the hold expires', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalProgramActivity(listener)
    const start = Date.now()
    noteTerminalTitle('t1', '✳ Claude Code', start)
    expect(isTerminalProgramBusy('t1', start)).toBe(false)
    noteTerminalTitle('t1', '⠋ Claude Code', start)
    expect(listener).toHaveBeenCalledTimes(1)
    noteTerminalTitle('t1', '✳ Claude Code', start + 100)
    expect(isTerminalProgramBusy('t1', start + 100)).toBe(true)
    expect(isTerminalProgramBusy('t1', start + 100 + SPINNER_HOLD_MS)).toBe(false)
    vi.advanceTimersByTime(SPINNER_HOLD_MS)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('forgets a terminal when it is cleared', () => {
    noteTerminalTitle('t1', '⠋ build')
    expect(isTerminalProgramBusy('t1')).toBe(true)
    clearTerminalProgramActivity('t1')
    expect(isTerminalProgramBusy('t1')).toBe(false)
  })
})
