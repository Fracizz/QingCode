import { describe, expect, it } from 'vitest'
import {
  filterUnownedDetachedTerminals,
  parseSshDetachedTerminal,
  planTerminalRestore,
  type SshDetachedTerminal,
} from './terminalRestorePlan'

function detached(overrides: Partial<SshDetachedTerminal> = {}): SshDetachedTerminal {
  return {
    ptyId: 'pty-1',
    connectionId: 'conn',
    cwd: 'ssh://conn/home/app',
    cols: 120,
    rows: 36,
    ...overrides,
  }
}

describe('planTerminalRestore', () => {
  it('attaches a restored persistent terminal before falling back to create', () => {
    expect(
      planTerminalRestore({
        persistent: true,
        ptyId: 'pty-1',
        connectionId: 'conn',
        cwd: 'ssh://conn/home/app',
        awaitingRestoreSpawn: true,
      })
    ).toEqual({
      mode: 'attach',
      ptyId: 'pty-1',
      connectionId: 'conn',
      cwd: 'ssh://conn/home/app',
      fallback: 'create',
    })
  })

  it('uses create for legacy snapshots and explicit restarts', () => {
    expect(
      planTerminalRestore({
        persistent: true,
        ptyId: 'pty-1',
        connectionId: 'conn',
        cwd: 'ssh://conn/home/app',
        awaitingRestoreSpawn: false,
      })
    ).toEqual({ mode: 'create' })
    expect(
      planTerminalRestore({
        persistent: false,
        ptyId: 'pty-1',
        connectionId: 'conn',
        cwd: 'ssh://conn/home/app',
        awaitingRestoreSpawn: true,
      })
    ).toEqual({ mode: 'create' })
    expect(
      planTerminalRestore({
        cwd: 'D:/app',
        awaitingRestoreSpawn: true,
      })
    ).toEqual({ mode: 'create' })
  })
})

describe('detached terminal filtering', () => {
  it('filters owned, duplicate, and other-connection PTYs', () => {
    expect(
      filterUnownedDetachedTerminals(
        [
          detached({ ptyId: 'owned' }),
          detached({ ptyId: 'orphan' }),
          detached({ ptyId: 'orphan' }),
          detached({ ptyId: 'other', connectionId: 'conn-2' }),
        ],
        [{ ptyId: 'owned', connectionId: 'conn' }],
        'conn'
      ).map(terminal => terminal.ptyId)
    ).toEqual(['orphan'])
  })

  it('rejects malformed list entries and preserves valid metadata', () => {
    expect(
      parseSshDetachedTerminal({
        ptyId: ' pty-2 ',
        connectionId: 'conn',
        cwd: 'ssh://conn/srv/app',
        cols: 100,
        rows: 30,
        name: ' OpenCode ',
      })
    ).toEqual({
      ptyId: 'pty-2',
      connectionId: 'conn',
      cwd: 'ssh://conn/srv/app',
      cols: 100,
      rows: 30,
      name: 'OpenCode',
    })
    expect(
      parseSshDetachedTerminal({
        ptyId: 'pty-2',
        connectionId: 'conn',
        cwd: '/srv/app',
        cols: 100,
        rows: 30,
      })
    ).toBeNull()
  })
})
