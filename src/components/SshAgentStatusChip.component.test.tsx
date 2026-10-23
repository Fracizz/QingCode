// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshAgentStatusChip from './SshAgentStatusChip'

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<(event: { payload: unknown }) => void>,
}))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => invoke(...args),
  NotInTauriError: class NotInTauriError extends Error {
    constructor(action: string) {
      super(action)
      this.name = 'NotInTauriError'
    }
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.push(callback)
    return () => {
      const index = listeners.indexOf(callback)
      if (index >= 0) listeners.splice(index, 1)
    }
  }),
}))

const rootUri = 'ssh://c1/home/app'

const ready = {
  connectionId: 'c1',
  rootUri,
  phase: 'readyAgent',
  mode: 'agent',
  version: '0.1.13',
  transport: 'daemon',
  reason: null,
}

describe('SshAgentStatusChip', () => {
  beforeEach(() => {
    listeners.splice(0, listeners.length)
    invoke.mockReset()
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_agent_info') return ready
      if (command === 'ssh_agent_restart') return { ...ready, version: '0.2.0' }
      if (command === 'ssh_agent_logs') return { text: 'daemon up' }
      throw new Error(`unexpected ${command}`)
    })
  })

  it('shows the agent version and ignores another project event', async () => {
    render(<SshAgentStatusChip rootUri={rootUri} />)
    expect(await screen.findByRole('button', { name: 'Agent v0.1.13' })).toBeTruthy()
    listeners[0]?.({ payload: { ...ready, rootUri: 'ssh://other/path', version: '9.9.9' } })
    expect(screen.getByRole('button', { name: 'Agent v0.1.13' })).toBeTruthy()
    listeners[0]?.({ payload: { ...ready, version: '0.2.0' } })
    expect(await screen.findByRole('button', { name: 'Agent v0.2.0' })).toBeTruthy()
  })

  it('restarts the agent from the menu', async () => {
    render(<SshAgentStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Agent v0.1.13' }))
    fireEvent.click(screen.getByText('重启 Agent'))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('重启 SSH Agent', 'ssh_agent_restart', { rootUri })
    })
    expect(await screen.findByRole('button', { name: 'Agent v0.2.0' })).toBeTruthy()
  })

  it('hides the chip when the command is missing', async () => {
    invoke.mockRejectedValue(Object.assign(new Error('command ssh_agent_info not found'), { name: 'Error' }))
    render(<SshAgentStatusChip rootUri={rootUri} />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })
})
