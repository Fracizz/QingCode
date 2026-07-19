import { describe, expect, it } from 'vitest'
import { isOneShotTaskTerminal, resolveTerminalBusy } from './terminalBusy'

describe('isOneShotTaskTerminal', () => {
  it('treats script kinds as one-shot', () => {
    expect(isOneShotTaskTerminal({ shellKind: 'ps1' })).toBe(true)
    expect(isOneShotTaskTerminal({ shellKind: 'command' })).toBe(true)
    expect(isOneShotTaskTerminal({ shellKind: 'interactive' })).toBe(false)
    expect(isOneShotTaskTerminal({})).toBe(false)
  })
})

describe('resolveTerminalBusy', () => {
  it('is never busy when exited', () => {
    expect(
      resolveTerminalBusy({
        status: 'exited',
        shellKind: 'ps1',
        commandRunning: true,
        hasMeaningfulChildren: true,
      }),
    ).toBe(false)
  })

  it('marks one-shot tasks busy until exit', () => {
    expect(
      resolveTerminalBusy({
        status: 'running',
        shellKind: 'command',
        commandRunning: null,
        hasMeaningfulChildren: false,
      }),
    ).toBe(true)
  })

  it('uses shell-integration command-running as busy', () => {
    expect(
      resolveTerminalBusy({
        status: 'running',
        commandRunning: true,
        hasMeaningfulChildren: false,
      }),
    ).toBe(true)
  })

  it('does not treat integration-idle as force-idle when children remain', () => {
    expect(
      resolveTerminalBusy({
        status: 'running',
        commandRunning: false,
        hasMeaningfulChildren: true,
      }),
    ).toBe(true)
  })

  it('is idle for interactive shells with no children and no command', () => {
    expect(
      resolveTerminalBusy({
        status: 'running',
        shellKind: 'interactive',
        commandRunning: false,
        hasMeaningfulChildren: false,
      }),
    ).toBe(false)
    expect(
      resolveTerminalBusy({
        status: 'running',
        commandRunning: null,
        hasMeaningfulChildren: false,
      }),
    ).toBe(false)
  })
})
