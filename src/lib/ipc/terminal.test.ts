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
      id: 'retry-stop',
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
