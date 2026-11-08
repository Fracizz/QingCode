import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OUTPUT_QUIET_AFTER_INPUT_MS,
  OUTPUT_STREAK_MS,
  SPINNER_HOLD_MS,
  clearTerminalProgramActivity,
  isSpinnerFrame,
  isTerminalProgramBusy,
  noteTerminalInput,
  noteTerminalOutput,
  noteTerminalTitle,
  subscribeTerminalProgramActivity,
} from './terminalProgramActivity'
import {
  clearTerminalCommandActivity,
  markTerminalCommandFinished,
} from './terminalCommandActivity'

describe('terminal program activity', () => {
  afterEach(() => {
    clearTerminalProgramActivity('t1')
    clearTerminalCommandActivity('t1')
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
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('forgets a terminal when it is cleared', () => {
    noteTerminalTitle('t1', '⠋ build')
    expect(isTerminalProgramBusy('t1')).toBe(true)
    clearTerminalProgramActivity('t1')
    expect(isTerminalProgramBusy('t1')).toBe(false)
  })

  /** 每 200ms 一块输出，持续 duration。 */
  function streamOutput(start: number, duration: number) {
    for (let at = start; at <= start + duration; at += 200) noteTerminalOutput('t1', at)
  }

  it('treats sustained output as running and stops after the hold', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalProgramActivity(listener)
    const start = Date.now()
    streamOutput(start, OUTPUT_STREAK_MS - 200)
    expect(isTerminalProgramBusy('t1', start + OUTPUT_STREAK_MS - 200)).toBe(false)
    noteTerminalOutput('t1', start + OUTPUT_STREAK_MS)
    expect(isTerminalProgramBusy('t1', start + OUTPUT_STREAK_MS)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    const last = start + OUTPUT_STREAK_MS
    expect(isTerminalProgramBusy('t1', last + SPINNER_HOLD_MS - 1)).toBe(true)
    expect(isTerminalProgramBusy('t1', last + SPINNER_HOLD_MS)).toBe(false)
    vi.advanceTimersByTime(OUTPUT_STREAK_MS + SPINNER_HOLD_MS)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('ignores a short burst of output such as a prompt redraw', () => {
    const start = Date.now()
    streamOutput(start, 400)
    expect(isTerminalProgramBusy('t1', start + 400)).toBe(false)
    // 间隔超过保持时间后重新计算连续段。
    streamOutput(start + 400 + SPINNER_HOLD_MS, 400)
    expect(isTerminalProgramBusy('t1', start + 800 + SPINNER_HOLD_MS)).toBe(false)
  })

  it('ignores echo right after input or resize', () => {
    const start = Date.now()
    for (let at = start; at <= start + 2000; at += 200) {
      noteTerminalInput('t1', at)
      noteTerminalOutput('t1', at + 50)
    }
    expect(isTerminalProgramBusy('t1', start + 2050)).toBe(false)
    noteTerminalInput('t1', start + 3000)
    streamOutput(start + 3000 + OUTPUT_QUIET_AFTER_INPUT_MS, OUTPUT_STREAK_MS)
    expect(isTerminalProgramBusy('t1', start + 3000 + OUTPUT_QUIET_AFTER_INPUT_MS + OUTPUT_STREAK_MS)).toBe(true)
  })

  it('ignores output while shell integration reports the prompt', () => {
    const start = Date.now()
    markTerminalCommandFinished('t1')
    streamOutput(start, OUTPUT_STREAK_MS * 2)
    expect(isTerminalProgramBusy('t1', start + OUTPUT_STREAK_MS * 2)).toBe(false)
  })
})
