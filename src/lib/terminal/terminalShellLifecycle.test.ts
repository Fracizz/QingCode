import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalDisconnectReason,
  parseTerminalExitEvent,
  planTerminalConnectionEvent,
  restoredExitRecovery,
  shouldCancelReconnectOnInput,
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

  it('reattaches live sessions and preserves confirmed exited shells', () => {
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
    ).toBe('exited')
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
        key: 'SSH 连接已断开（{reason}），正在重新连接…',
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

  it('reports prolonged retries with the latest failure without claiming the process is alive', () => {
    for (const attempt of [3, 5, 10]) {
      expect(planTerminalConnectionEvent(tab('reconnecting'), {
        id: 't1', state: 'reconnecting', attempt, reason: 'daemon 握手失败',
      })).toMatchObject({
        notice: {
          key: 'SSH 终端正在第 {attempt} 次重连（{reason}）…',
          values: { attempt, reason: 'daemon 握手失败' },
        },
      })
    }
    expect(planTerminalConnectionEvent(tab('reconnecting'), {
      id: 't1', state: 'reconnecting', attempt: 4,
    })?.notice).toBeNull()
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

describe('shouldCancelReconnectOnInput', () => {
  it('cancels a server-mode reconnect on a lone Ctrl+C', () => {
    expect(shouldCancelReconnectOnInput({ status: 'reconnecting' }, false, '')).toBe(true)
  })

  it('cancels a direct SSH backoff only while recovering', () => {
    expect(shouldCancelReconnectOnInput({ status: 'starting' }, true, '')).toBe(true)
    expect(shouldCancelReconnectOnInput({ status: 'starting' }, false, '')).toBe(false)
  })

  it('leaves other keys and connected terminals alone', () => {
    expect(shouldCancelReconnectOnInput({ status: 'reconnecting' }, false, 'a')).toBe(false)
    expect(shouldCancelReconnectOnInput({ status: 'reconnecting' }, false, '')).toBe(false)
    expect(shouldCancelReconnectOnInput({ status: 'running' }, false, '')).toBe(false)
    expect(shouldCancelReconnectOnInput({ status: 'exited' }, true, '')).toBe(false)
  })
})
