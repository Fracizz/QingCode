import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalDisconnectReason,
  parseTerminalExitEvent,
  planTerminalConnectionEvent,
  restoredExitRecovery,
  shouldKeepShellAfterExit,
  sshTerminalReconnectDelay,
  terminalDisconnectNotice,
} from '@/lib/terminal/terminalShellLifecycle'
import type { TerminalTab } from '@/types'

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

describe('planTerminalConnectionEvent', () => {
  const tab = (status: TerminalTab['status'] = 'running') => ({ status })

  it('shows the reconnect notice once and stays quiet for repeated attempts', () => {
    const first = planTerminalConnectionEvent(tab(), {
      id: 't1',
      state: 'reconnecting',
      attempt: 1,
      reason: 'keepalive timeout',
    })
    expect(first).toMatchObject({
      status: 'reconnecting',
      reason: 'keepalive timeout',
      attempt: 1,
      notice: {
        key: 'SSH 连接已断开（{reason}），正在重新连接，远端进程仍在运行…',
        values: { reason: 'keepalive timeout' },
      },
    })

    const repeated = planTerminalConnectionEvent(tab('reconnecting'), {
      id: 't1',
      state: 'reconnecting',
      attempt: 2,
    })
    expect(repeated).toMatchObject({ status: 'reconnecting', notice: null, attempt: 2 })
  })

  it.each([
    ['replay', '已重新连接'],
    ['snapshot', '已重新连接（已从屏幕快照恢复，部分历史输出不可用）'],
    ['none', '已重新连接'],
  ] as const)('returns to running for attached restore=%s', (restore, notice) => {
    expect(
      planTerminalConnectionEvent(tab('reconnecting'), {
        id: 't1',
        state: 'attached',
        restore,
      }),
    ).toMatchObject({
      status: 'running',
      restore,
      notice: { key: notice },
    })
  })

  it('ignores malformed payloads and non-string reasons', () => {
    expect(planTerminalConnectionEvent(tab(), null)).toBeNull()
    expect(planTerminalConnectionEvent(tab(), { id: '', state: 'reconnecting' })).toBeNull()
    expect(planTerminalConnectionEvent(tab(), { id: 't1', state: 'lost' })).toBeNull()
    expect(
      planTerminalConnectionEvent(tab(), {
        id: 't1',
        state: 'reconnecting',
        reason: 42,
      }),
    ).toBeNull()
    expect(
      planTerminalConnectionEvent(tab(), {
        id: 't1',
        state: 'attached',
        restore: 'invalid',
      }),
    ).toBeNull()
  })
})

describe('terminalDisconnectNotice', () => {
  it('includes a valid reason and preserves the legacy text without one', () => {
    expect(terminalDisconnectNotice('reconnecting', 'keepalive timeout')).toEqual({
      key: 'SSH 连接已断开（{reason}），正在重新连接…',
      values: { reason: 'keepalive timeout' },
    })
    expect(terminalDisconnectNotice('reconnecting', null)).toEqual({
      key: 'SSH 连接已断开，正在重新连接…',
    })
    expect(terminalDisconnectNotice('stopped', 'remote closed')).toEqual({
      key: 'SSH 连接已断开（{reason}），任务已中止，可从终端标签重启',
      values: { reason: 'remote closed' },
    })
    expect(terminalDisconnectNotice('stopped', undefined)).toEqual({
      key: 'SSH 连接已断开，任务已中止，可从终端标签重启',
    })
  })

  it('ignores non-string reasons', () => {
    expect(normalizeTerminalDisconnectReason(42)).toBeNull()
    expect(normalizeTerminalDisconnectReason('   ')).toBeNull()
    expect(terminalDisconnectNotice('stopped', { reason: 'bad' })).toEqual({
      key: 'SSH 连接已断开，任务已中止，可从终端标签重启',
    })
  })
})

describe('parseTerminalExitEvent', () => {
  it('accepts camelCase and snake_case exit fields', () => {
    expect(
      parseTerminalExitEvent({
        id: 't1',
        exitCode: 7,
        disconnected: true,
        reason: 'remote closed',
      }),
    ).toEqual({
      id: 't1',
      exitCode: 7,
      disconnected: true,
      reason: 'remote closed',
    })
    expect(
      parseTerminalExitEvent({
        id: 't1',
        exit_code: 0,
        disconnected: false,
      }),
    ).toEqual({
      id: 't1',
      exitCode: 0,
      disconnected: false,
      reason: null,
    })
  })

  it('ignores a non-string reason without dropping the exit event', () => {
    expect(
      parseTerminalExitEvent({
        id: 't1',
        exit_code: 1,
        disconnected: true,
        reason: { message: 'bad' },
      }),
    ).toEqual({
      id: 't1',
      exitCode: 1,
      disconnected: true,
      reason: null,
    })
    expect(parseTerminalExitEvent({ id: 't1', exit_code: '1' })).toBeNull()
  })
})
