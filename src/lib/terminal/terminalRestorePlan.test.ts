import { describe, expect, it } from 'vitest'
import {
  filterUnownedDetachedTerminals,
  parseSshDetachedTerminal,
  planTerminalRestore,
  terminalRestoreNotices,
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
  it('attaches a restored persistent terminal without falling back to create', () => {
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
      fallback: 'stop',
    })
  })

  it('falls back to create only for locally hosted terminals', () => {
    expect(
      planTerminalRestore({
        persistent: true,
        ptyId: 'pty-1',
        connectionId: '__local__',
        cwd: 'D:\\work\\app',
        awaitingRestoreSpawn: true,
      })
    ).toEqual({
      mode: 'attach',
      ptyId: 'pty-1',
      connectionId: '__local__',
      cwd: 'D:\\work\\app',
      fallback: 'create',
    })
    expect(
      planTerminalRestore({
        cwd: 'D:\\work\\app',
        awaitingRestoreSpawn: true,
      })
    ).toEqual({ mode: 'create' })
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

describe.each([
  ['Linux', '/home/dev/app'],
  ['Windows', 'D:/app'],
  ['macOS', '/Users/dev/app'],
])('%s terminal restore presentation', (_platform, path) => {
  const restored = {
    persistent: true, ptyId: 'original-pty', connectionId: 'conn',
    cwd: `ssh://conn/${path.replace(/^\/+/, '')}`, awaitingRestoreSpawn: true,
  }

  it('reattaches the original process without a restart banner or screen reset', () => {
    expect(planTerminalRestore(restored).mode).toBe('attach')
    expect(terminalRestoreNotices(restored)).toEqual({
      history: '会话输出已恢复；正在接回原终端…', starting: null,
    })
  })

  it('distinguishes local history revival and explicit restart from reattachment', () => {
    for (const tab of [
      { ...restored, persistent: false, cwd: path },
      { ...restored, awaitingRestoreSpawn: false },
    ]) {
      expect(planTerminalRestore(tab).mode).toBe('create')
      expect(terminalRestoreNotices(tab)).toEqual({
        history: '会话输出已恢复；进程将按原配置重新启动', starting: '正在重启终端…',
      })
    }
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
        'conn',
        'ssh://conn/home/app'
      ).map(terminal => terminal.ptyId)
    ).toEqual(['orphan'])
  })

  it('keeps orphans inside the current project root and leaves nested or sibling projects alone', () => {
    expect(
      filterUnownedDetachedTerminals(
        [
          detached({ ptyId: 'root', cwd: 'ssh://conn/srv/a' }),
          detached({ ptyId: 'child', cwd: 'ssh://conn/srv/a/src' }),
          detached({ ptyId: 'sibling', cwd: 'ssh://conn/srv/b' }),
          detached({ ptyId: 'prefix', cwd: 'ssh://conn/srv/ab' }),
          detached({ ptyId: 'nested', cwd: 'ssh://conn/srv/a/sub/x' }),
        ],
        [],
        'conn',
        'ssh://conn/srv/a/',
        ['ssh://conn/srv/b', 'ssh://conn/srv/a/sub']
      ).map(terminal => terminal.ptyId)
    ).toEqual(['root', 'child'])
    // Windows 盘符路径不区分大小写。
    expect(
      filterUnownedDetachedTerminals(
        [detached({ ptyId: 'win', cwd: 'ssh://conn/d:/Code/App' })],
        [],
        'conn',
        'ssh://conn/D:/code/app'
      ).map(terminal => terminal.ptyId)
    ).toEqual(['win'])
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

  it('converts the remaining detached time to a local deadline', () => {
    const base = { ptyId: 'pty-2', connectionId: 'conn', cwd: 'ssh://conn/srv/app', cols: 100, rows: 30 }
    expect(parseSshDetachedTerminal({ ...base, detachedRemainingMs: 60_000 }, 1_000)?.expiresAt).toBe(61_000)
    expect(parseSshDetachedTerminal(base, 1_000)).not.toHaveProperty('expiresAt')
  })
})
