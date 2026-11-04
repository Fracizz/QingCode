import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
}))

vi.mock('../tauri', () => ({
  isSshResource: (value: unknown) => typeof value === 'string' && value.startsWith('ssh://'),
  safeInvoke: (...args: unknown[]) => mocks.safeInvoke(...args),
}))

import { attachTerminal, killDetachedTerminal, killTerminal, listDetachedTerminals } from './terminal'

beforeEach(() => {
  mocks.safeInvoke.mockReset()
})

describe('SSH detached terminal IPC contract', () => {
  it('uses explicit PTY metadata for exit decisions without sweeping a connection', async () => {
    const { finishRemoteTerminalOnExit } = await import('./terminal')
    mocks.safeInvoke.mockResolvedValue(undefined)
    const args = { id: 'tab-a', ptyId: 'pty-a', cwd: 'ssh://conn/home/app', action: 'preserve' as const }
    await finishRemoteTerminalOnExit(args)
    expect(mocks.safeInvoke).toHaveBeenLastCalledWith('处理退出时的远程终端', 'ssh_finish_terminal_on_exit', args)
    mocks.safeInvoke.mockRejectedValueOnce(new Error('unconfirmed'))
    await expect(finishRemoteTerminalOnExit({ ...args, action: 'terminate' })).rejects.toThrow('unconfirmed')
  })

  it('closes a compatibility terminal using its URI even without a spawned-session cache entry', async () => {
    const { closeTerminalOnExit } = await import('./terminal')
    mocks.safeInvoke.mockResolvedValue(undefined)
    await closeTerminalOnExit({ id: 'restored-compat', cwd: 'ssh://conn/home/app' })
    expect(mocks.safeInvoke).toHaveBeenLastCalledWith('关闭终端', 'ssh_kill_terminal', {
      id: 'restored-compat', source: 'app_exit', operationId: expect.any(String),
    })
  })
  it('ends a detached PTY without creating an attached local session', async () => {
    mocks.safeInvoke.mockResolvedValueOnce(undefined)
    const args = { ptyId: 'idle-pty', cwd: 'ssh://conn/home/app' }
    await killDetachedTerminal(args)
    expect(mocks.safeInvoke).toHaveBeenCalledExactlyOnceWith(
      '结束远端终端', 'ssh_kill_detached_terminal', args,
    )
  })

  it('retains SSH routing after a failed stop so retries reach the same remote task', async () => {
    mocks.safeInvoke.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'retry-pty',
      connectionId: 'conn',
    })
    await attachTerminal({
      id: 'retry-stop',
      ptyId: 'retry-pty',
      cwd: 'ssh://conn/home/app',
      cols: 80,
      rows: 24,
    })
    mocks.safeInvoke.mockRejectedValueOnce(new Error('offline'))
    await expect(killTerminal('retry-stop')).rejects.toThrow('offline')
    mocks.safeInvoke.mockResolvedValueOnce(undefined)
    await killTerminal('retry-stop')
    expect(mocks.safeInvoke).toHaveBeenLastCalledWith('关闭终端', 'ssh_kill_terminal', {
      id: 'retry-stop', source: 'user_close', operationId: expect.any(String),
    })
  })
  it('lists detached terminals by connection id and drops malformed entries', async () => {
    mocks.safeInvoke.mockResolvedValueOnce([
      {
        ptyId: 'pty-1',
        connectionId: 'conn',
        cwd: 'ssh://conn/home/app',
        cols: 100,
        rows: 30,
      },
      { ptyId: 'bad' },
    ])

    await expect(listDetachedTerminals('conn')).resolves.toEqual([
      {
        ptyId: 'pty-1',
        connectionId: 'conn',
        cwd: 'ssh://conn/home/app',
        cols: 100,
        rows: 30,
      },
    ])
    expect(mocks.safeInvoke).toHaveBeenCalledWith('查询远端终端', 'ssh_list_detached_terminals', {
      connectionId: 'conn',
    })
  })

  it('attaches with the plan parameter names', async () => {
    const args = {
      id: 'term-1',
      ptyId: 'pty-1',
      cwd: 'ssh://conn/home/app',
      cols: 120,
      rows: 40,
    }
    mocks.safeInvoke.mockResolvedValueOnce({
      persistent: true,
      ptyId: 'pty-1',
      connectionId: 'conn',
    })

    await expect(attachTerminal(args)).resolves.toMatchObject({
      persistent: true,
      ptyId: 'pty-1',
    })
    expect(mocks.safeInvoke).toHaveBeenCalledWith('接回 SSH 终端', 'ssh_attach_terminal', args)
  })
})
