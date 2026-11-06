import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_TERMINAL_ACTIVITY,
  clearTerminalTitleSignal,
  getTerminalActivityPhase,
  isAgentStatusTitle,
  isSpinnerTitleFrame,
  nextTerminalActivity,
  publishTerminalActivity,
  recordTerminalTitle,
  subscribeTerminalActivity,
  terminalTitleSignal,
  type TerminalActivityInput,
  type TerminalActivityState,
} from './terminalActivity'

const input = (overrides: Partial<TerminalActivityInput> = {}): TerminalActivityInput => ({
  status: 'running',
  agentTitle: false,
  spinnerActive: false,
  oneShot: false,
  hasChildren: false,
  viewed: false,
  ...overrides,
})

const running = (source: 'title' | 'process', runningSince = 0): TerminalActivityState => ({
  phase: 'running',
  runningSince,
  source,
})

describe('nextTerminalActivity', () => {
  it('runs on child processes for plain shells and on one-shot tasks until exit', () => {
    expect(nextTerminalActivity(IDLE_TERMINAL_ACTIVITY, input(), 0).phase).toBe('idle')
    expect(nextTerminalActivity(IDLE_TERMINAL_ACTIVITY, input({ hasChildren: true }), 0).phase).toBe('running')
    expect(nextTerminalActivity(IDLE_TERMINAL_ACTIVITY, input({ oneShot: true }), 0).phase).toBe('running')
    expect(nextTerminalActivity(running('process'), input({ status: 'exited', oneShot: true }), 9000).phase).toBe('unseen')
  })

  it('ignores the agent child process and follows only its title', () => {
    const idleAgent = input({ agentTitle: true, hasChildren: true })
    expect(nextTerminalActivity(IDLE_TERMINAL_ACTIVITY, idleAgent, 0).phase).toBe('idle')
    const working = nextTerminalActivity(IDLE_TERMINAL_ACTIVITY, { ...idleAgent, spinnerActive: true }, 0)
    expect(working).toEqual(running('title'))
    expect(nextTerminalActivity(working, idleAgent, 9000).phase).toBe('unseen')
  })

  it('does not treat agent startup as a finished task', () => {
    // 探测先看到子进程，之后 Agent 才设置 `✳` 标题。
    expect(nextTerminalActivity(running('process'), input({ agentTitle: true }), 9000)).toBe(IDLE_TERMINAL_ACTIVITY)
  })

  it('marks unseen only when the run was long enough and the tab was not viewed', () => {
    expect(nextTerminalActivity(running('process'), input(), 2999)).toBe(IDLE_TERMINAL_ACTIVITY)
    expect(nextTerminalActivity(running('process'), input({ viewed: true }), 9000)).toBe(IDLE_TERMINAL_ACTIVITY)
    expect(nextTerminalActivity(running('process'), input(), 3000).phase).toBe('unseen')
  })

  it('keeps unseen until viewed and lets a new run replace it', () => {
    const unseen = nextTerminalActivity(running('process'), input(), 9000)
    expect(nextTerminalActivity(unseen, input(), 20000)).toBe(unseen)
    expect(nextTerminalActivity(unseen, input({ viewed: true }), 20000)).toBe(IDLE_TERMINAL_ACTIVITY)
    expect(nextTerminalActivity(unseen, input({ hasChildren: true }), 20000)).toEqual(running('process', 20000))
  })

  it('keeps the start time when the signal source changes and returns the same object when stable', () => {
    const next = nextTerminalActivity(running('process', 5), input({ spinnerActive: true }), 100)
    expect(next).toEqual(running('title', 5))
    expect(nextTerminalActivity(next, input({ spinnerActive: true }), 200)).toBe(next)
  })

  it('freezes while reconnecting and resets on restart', () => {
    const prev = running('title')
    expect(nextTerminalActivity(prev, input({ status: 'reconnecting' }), 9000)).toBe(prev)
    expect(nextTerminalActivity(prev, input({ status: 'starting' }), 9000)).toBe(IDLE_TERMINAL_ACTIVITY)
  })
})

describe('title signals', () => {
  beforeEach(() => clearTerminalTitleSignal('t'))

  it('detects spinner frames like the backend', () => {
    expect(isSpinnerTitleFrame(null, '⠋ 构建')).toBe(true)
    expect(isSpinnerTitleFrame('⠋ 构建', '\u2800 构建')).toBe(true)
    expect(isSpinnerTitleFrame('| build', '/ build')).toBe(true)
    expect(isSpinnerTitleFrame('| build', '/ test')).toBe(false)
    expect(isSpinnerTitleFrame(null, '✳ Claude Code')).toBe(false)
    expect(isSpinnerTitleFrame('D:/code', 'D:/other')).toBe(false)
  })

  it('recognizes symbol-prefixed agent titles but not shell titles', () => {
    expect(isAgentStatusTitle('✳ Claude Code')).toBe(true)
    expect(isAgentStatusTitle('⠋ 任务')).toBe(true)
    expect(isAgentStatusTitle('D:\\code\\qingcode')).toBe(false)
    expect(isAgentStatusTitle('~/code')).toBe(false)
    expect(isAgentStatusTitle('- build')).toBe(false)
    expect(isAgentStatusTitle('npm run dev')).toBe(false)
  })

  it('holds busy for a window after the last spinner frame', () => {
    recordTerminalTitle('t', '⠋ 任务', 1000)
    // 与后端一致：只有符号变化、文字不变也算一帧，所以保持窗口从最后这次变化算起。
    recordTerminalTitle('t', '✳ 任务', 1500)
    expect(terminalTitleSignal('t', 4499)).toEqual({ agentTitle: true, spinnerActive: true })
    expect(terminalTitleSignal('t', 4500)).toEqual({ agentTitle: true, spinnerActive: false })
  })

  it('stays busy while the title itself is a spinner frame and has no signal after clearing', () => {
    recordTerminalTitle('t', '⠋ 任务', 1000)
    expect(terminalTitleSignal('t', 60000).spinnerActive).toBe(true)
    clearTerminalTitleSignal('t')
    expect(terminalTitleSignal('t', 60000)).toEqual({ agentTitle: false, spinnerActive: false })
  })
})

describe('publishTerminalActivity', () => {
  beforeEach(() => publishTerminalActivity(new Map()))

  it('notifies only when a displayed phase changes and drops closed terminals', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalActivity(listener)
    publishTerminalActivity(new Map([['a', running('title', 1)]]))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getTerminalActivityPhase('a')).toBe('running')
    publishTerminalActivity(new Map([['a', running('process', 1)]]))
    expect(listener).toHaveBeenCalledTimes(1)
    publishTerminalActivity(new Map())
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getTerminalActivityPhase('a')).toBe('idle')
    unsubscribe()
  })
})
