import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OUTPUT_QUIET_AFTER_INPUT_MS,
  OUTPUT_STREAK_MS,
  REDRAW_GAP_MS,
  REDRAW_MAX_MS,
  SPINNER_HOLD_MS,
  clearTerminalProgramActivity,
  isSpinnerFrame,
  getTerminalLastWorkAt,
  getTerminalProgramBusySnapshot,
  getTerminalProgramTitle,
  isTerminalProgramBusy,
  noteTerminalProgramState,
  noteTerminalReplayedTitle,
  noteTerminalScreenSnapshot,
  noteTerminalSubmit,
  noteTerminalInput,
  noteTerminalOutput,
  noteTerminalResize,
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

  it('trusts the program report over the title and output heuristics', () => {
    vi.useFakeTimers()
    const start = Date.now()
    noteTerminalTitle('t1', '⠋ idlecwd', start)
    streamOutput(start, OUTPUT_STREAK_MS * 2)
    expect(isTerminalProgramBusy('t1', start + 100)).toBe(true)
    noteTerminalProgramState('t1', 'idle', start + 2100)
    expect(isTerminalProgramBusy('t1', start + 2100)).toBe(false)

    noteTerminalTitle('t1', 'idlecwd', start + 10_000)
    noteTerminalProgramState('t1', 'working', start + 10_000)
    // 模型长时间没有输出也保持运行中。
    expect(isTerminalProgramBusy('t1', start + 600_000)).toBe(true)
    noteTerminalProgramState('t1', 'clear', start + 600_000)
    expect(isTerminalProgramBusy('t1', start + 600_000)).toBe(false)
  })

  it('stops immediately when the program reports done', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalProgramActivity(listener)
    const start = Date.now()
    noteTerminalProgramState('t1', 'working', start)
    expect(listener).toHaveBeenCalledTimes(1)
    noteTerminalProgramState('t1', 'idle', start + 50)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getTerminalProgramBusySnapshot('t1')).toBe(false)
    unsubscribe()
  })

  it('drops a stale report on submit so later shell commands are detected', () => {
    const start = Date.now()
    noteTerminalProgramState('t1', 'idle', start)
    noteTerminalSubmit('t1', start + 1000)
    streamOutput(start + 2000, OUTPUT_STREAK_MS)
    expect(isTerminalProgramBusy('t1', start + 2000 + OUTPUT_STREAK_MS)).toBe(true)
  })

  it('does not let a report suppress the spinner after submit while still working', () => {
    const start = Date.now()
    noteTerminalTitle('t1', '⠋ idlecwd', start)
    noteTerminalProgramState('t1', 'working', start)
    noteTerminalSubmit('t1', start + 10)
    expect(isTerminalProgramBusy('t1', start + 10)).toBe(true)
  })

  it('releases a spinner title that a screen snapshot can no longer finish', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalProgramActivity(listener)
    const start = Date.now()
    noteTerminalTitle('t1', '⠼ 关闭终端鼠标接管 | django', start)
    expect(getTerminalProgramBusySnapshot('t1')).toBe(true)
    // 断线期间错过了恢复标题的那一帧，接回时只收到快照。
    vi.setSystemTime(start + 60_000)
    noteTerminalScreenSnapshot('t1', start + 60_000)
    expect(getTerminalProgramBusySnapshot('t1')).toBe(false)
    expect(getTerminalProgramTitle('t1')).toBe('关闭终端鼠标接管 | django')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('discards a pre-snapshot report and ignores unknown terminals', () => {
    const start = Date.now()
    noteTerminalProgramState('t1', 'working', start)
    noteTerminalScreenSnapshot('t1', start + 10)
    expect(isTerminalProgramBusy('t1', start + 10)).toBe(false)
    noteTerminalScreenSnapshot('missing', start)
    noteTerminalSubmit('missing', start)
    expect(isTerminalProgramBusy('missing', start)).toBe(false)
  })

  it('keeps replayed title text without treating history as work', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalProgramActivity(listener)
    const start = Date.now()
    noteTerminalReplayedTitle('t1', '⠋ build', start)
    noteTerminalReplayedTitle('t1', '✶ build', start + 1)
    noteTerminalReplayedTitle('t1', '⠼ Claude Code', start + 2)
    vi.advanceTimersByTime(SPINNER_HOLD_MS * 2)
    expect(listener).not.toHaveBeenCalled()
    expect(isTerminalProgramBusy('t1', start + 3)).toBe(false)
    expect(getTerminalProgramTitle('t1')).toBe('Claude Code')
    // 程序仍在工作时，下一帧实时转圈马上恢复状态。
    noteTerminalTitle('t1', '⠋ Claude Code', start + 10)
    expect(getTerminalProgramBusySnapshot('t1')).toBe(true)
    unsubscribe()
  })

  it('reports when the last work signal was seen', () => {
    const start = Date.now()
    noteTerminalTitle('t1', '⠋ build', start)
    noteTerminalTitle('t1', '✳ build', start + 500)
    expect(getTerminalLastWorkAt('t1', start + 3000)).toBe(start + 500)
    // 主动上报没有保持期，翻转的此刻就是结束时刻。
    noteTerminalProgramState('t1', 'idle', start + 4000)
    expect(getTerminalLastWorkAt('t1', start + 4000)).toBe(start + 4000)
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

  it('ignores a long redraw after resizing an idle terminal', () => {
    const start = Date.now()
    noteTerminalResize('t1', start)
    // 重印长对话：持续数秒、块间隔很短，都算这一段重绘。
    streamOutput(start + 100, 4000)
    expect(isTerminalProgramBusy('t1', start + 4100)).toBe(false)
    // 重绘段因间隔断开后，新的持续输出照常算运行中。
    const later = start + 4100 + REDRAW_GAP_MS + 1
    streamOutput(later, OUTPUT_STREAK_MS)
    expect(isTerminalProgramBusy('t1', later + OUTPUT_STREAK_MS)).toBe(true)
  })

  it('ends the redraw on keyboard input or after the cap', () => {
    const start = Date.now()
    noteTerminalResize('t1', start)
    streamOutput(start + 100, 400)
    noteTerminalInput('t1', start + 600)
    const typed = start + 600 + OUTPUT_QUIET_AFTER_INPUT_MS
    streamOutput(typed, OUTPUT_STREAK_MS)
    expect(isTerminalProgramBusy('t1', typed + OUTPUT_STREAK_MS)).toBe(true)

    clearTerminalProgramActivity('t1')
    noteTerminalResize('t1', start)
    streamOutput(start + 100, REDRAW_MAX_MS + OUTPUT_STREAK_MS + 400)
    expect(isTerminalProgramBusy('t1', start + REDRAW_MAX_MS + OUTPUT_STREAK_MS + 500)).toBe(true)
  })

  it('keeps counting output when resized mid-build', () => {
    const start = Date.now()
    streamOutput(start, OUTPUT_STREAK_MS)
    expect(isTerminalProgramBusy('t1', start + OUTPUT_STREAK_MS)).toBe(true)
    noteTerminalResize('t1', start + OUTPUT_STREAK_MS + 100)
    streamOutput(start + OUTPUT_STREAK_MS + 100 + OUTPUT_QUIET_AFTER_INPUT_MS, 2000)
    const end = start + OUTPUT_STREAK_MS + 2100 + OUTPUT_QUIET_AFTER_INPUT_MS
    expect(isTerminalProgramBusy('t1', end)).toBe(true)
  })

  it('ignores output while shell integration reports the prompt', () => {
    const start = Date.now()
    markTerminalCommandFinished('t1')
    streamOutput(start, OUTPUT_STREAK_MS * 2)
    expect(isTerminalProgramBusy('t1', start + OUTPUT_STREAK_MS * 2)).toBe(false)
  })
})
