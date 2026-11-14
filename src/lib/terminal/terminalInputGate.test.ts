import { afterEach, describe, expect, it } from 'vitest'
import {
  DRAFT_WAIT_MS,
  forgetHumanTerminalInput,
  INPUT_QUIET_MS,
  inputGateDelay,
  noteHumanTerminalInput,
  waitForHumanInputQuiet,
} from './terminalInputGate'
import { applyTerminalControlPayload, useTerminalControlStore } from '@/store/terminalControlStore'

describe('terminal input gate', () => {
  afterEach(() => {
    forgetHumanTerminalInput('t')
    useTerminalControlStore.setState({ controls: {} })
  })

  it('writes immediately when nobody has typed', () => {
    expect(inputGateDelay('t', 1000, 1000)).toBe(0)
  })

  it('waits for the quiet period after a submitted command', () => {
    noteHumanTerminalInput('t', 'ls\r', 1000)
    expect(inputGateDelay('t', 2000, 2000)).toBe(INPUT_QUIET_MS - 1000)
    expect(inputGateDelay('t', 2000, 1000 + INPUT_QUIET_MS)).toBe(0)
  })

  it('waits for an unsent draft up to the cap', () => {
    noteHumanTerminalInput('t', 'git com', 1000)
    const start = 10_000
    expect(inputGateDelay('t', start, start)).toBe(DRAFT_WAIT_MS)
    // 回车提交后只剩安静期。
    noteHumanTerminalInput('t', '\r', start + 5000)
    expect(inputGateDelay('t', start, start + 5000)).toBe(INPUT_QUIET_MS)
    noteHumanTerminalInput('t', 'x', start + 6000)
    expect(inputGateDelay('t', start, start + INPUT_QUIET_MS + DRAFT_WAIT_MS)).toBe(0)
  })

  it('respects recent typing on another device', () => {
    applyTerminalControlPayload({
      id: 't', rev: 1, viewers: [{ id: 'p', kind: 'device', name: 'Pixel', observe: false, typing: true }],
      lastInput: { name: 'Pixel', kind: 'device', at: 5000 },
    })
    expect(inputGateDelay('t', 6000, 6000)).toBe(INPUT_QUIET_MS - 1000)
  })

  it('sleeps in steps until the gate opens', async () => {
    noteHumanTerminalInput('t', 'ls\r', 500)
    let clock = 1000
    const sleeps: number[] = []
    await waitForHumanInputQuiet('t', async ms => { sleeps.push(ms); clock += ms }, () => clock)
    expect(clock).toBeGreaterThanOrEqual(INPUT_QUIET_MS)
    expect(sleeps.every(ms => ms <= 500)).toBe(true)
  })
})
