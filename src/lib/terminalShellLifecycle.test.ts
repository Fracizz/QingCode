import { describe, expect, it } from 'vitest'
import { shouldKeepShellAfterExit } from './terminalShellLifecycle'

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
