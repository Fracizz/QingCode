import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
}))

vi.mock('../tauri', () => ({
  isSshResource: (value: unknown) => typeof value === 'string' && value.startsWith('ssh://'),
  safeInvoke: (...args: unknown[]) => mocks.safeInvoke(...args),
}))

import { attachTerminal, listDetachedTerminals } from './terminal'

beforeEach(() => {
  mocks.safeInvoke.mockReset()
})

describe('SSH detached terminal IPC contract', () => {
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
