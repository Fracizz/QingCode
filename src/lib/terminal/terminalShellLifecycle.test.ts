import { describe, expect, it } from 'vitest'
import {
  restoredExitRecovery,
  shouldKeepShellAfterExit,
  sshTerminalReconnectDelay,
} from '@/lib/terminal/terminalShellLifecycle'

describe('shouldKeepShellAfterExit', () => {
  it('keeps plain and profile shells alive', () => {
    expect(shouldKeepShellAfterExit({ launchCommand: '', profileId: 'default' })).toBe(true)
    expect(
      shouldKeepShellAfterExit({
        launchCommand: 'opencode',
        profileId: 'opencode',
      }),
    ).toBe(true)
    expect(
      shouldKeepShellAfterExit({
        launchCommand: 'opencode',
        shellKind: 'interactive',
        profileId: 'opencode',
      }),
    ).toBe(true)
  })

  it('keeps a live session writable and only locks a finished one-shot task', () => {
    expect(
      restoredExitRecovery({
        awaitingRestoreSpawn: false,
        sessionOpen: true,
        keepShell: true,
      }),
    ).toBe('reattach')
    expect(
      restoredExitRecovery({
        awaitingRestoreSpawn: false,
        sessionOpen: false,
        keepShell: true,
      }),
    ).toBe('respawn')
    expect(
      restoredExitRecovery({
        awaitingRestoreSpawn: true,
        sessionOpen: false,
        keepShell: true,
      }),
    ).toBe('await-spawn')
    expect(
      restoredExitRecovery({
        awaitingRestoreSpawn: false,
        sessionOpen: false,
        keepShell: false,
      }),
    ).toBe('locked')
  })

  it('leaves one-shot run-config tasks exited', () => {
    expect(
      shouldKeepShellAfterExit({
        launchCommand: 'build.ps1',
        shellKind: 'ps1',
      }),
    ).toBe(false)
    expect(
      shouldKeepShellAfterExit({
        launchCommand: 'npm test',
        shellKind: 'command',
      }),
    ).toBe(false)
  })
})

describe('sshTerminalReconnectDelay', () => {
  it('backs off and then gives up', () => {
    expect(sshTerminalReconnectDelay(0)).toBe(1_000)
    expect(sshTerminalReconnectDelay(1)).toBe(2_000)
    expect(sshTerminalReconnectDelay(4)).toBe(20_000)
    expect(sshTerminalReconnectDelay(5)).toBeNull()
  })
})
