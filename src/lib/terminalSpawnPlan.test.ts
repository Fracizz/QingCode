import { describe, expect, it } from 'vitest'
import { planTerminalSpawn } from './terminalSpawnPlan'

describe('planTerminalSpawn', () => {
  it('uses a plain shell when there is no startup command', () => {
    expect(planTerminalSpawn({ launchCommand: '' })).toEqual({ mode: 'shell' })
  })

  it('uses interactive for profile startup commands', () => {
    expect(planTerminalSpawn({ launchCommand: 'opencode' })).toEqual({
      mode: 'interactive',
      command: 'opencode',
    })
    expect(
      planTerminalSpawn({
        launchCommand: 'opencode',
        shellKind: 'interactive',
      }),
    ).toEqual({ mode: 'interactive', command: 'opencode' })
  })

  it('uses script mode for one-shot run-config tasks', () => {
    expect(
      planTerminalSpawn({
        launchCommand: 'build.ps1',
        shellKind: 'ps1',
        env: { FOO: '1' },
      }),
    ).toEqual({
      mode: 'script',
      shellKind: 'ps1',
      target: 'build.ps1',
      env: { FOO: '1' },
    })
  })
})
