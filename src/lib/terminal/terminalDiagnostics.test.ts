import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '@/types'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: true }))
vi.mock('../tauri', () => ({
  isTauri: () => mocks.native,
  isSshResource: (value: unknown) => typeof value === 'string' && value.startsWith('ssh://'),
  safeInvoke: (...args: unknown[]) => mocks.invoke(...args),
}))

import { collectTerminalDiagnostics, recordTerminalDiagnostic } from './terminalDiagnostics'

const terminal: TerminalTab = {
  id: 'tab-one', name: 'private-name', projectId: 'project-one', cwd: 'ssh://conn/home/app',
  ptyId: 'old-pty', connectionId: 'conn', status: 'exited', exitCode: 1,
  launchCommand: 'private-command', env: { SECRET: 'private-env-value' },
}

beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(''); mocks.native = true })

describe('terminal diagnostic metadata', () => {
  it('records identity and action correlation without commands or environment values', () => {
    recordTerminalDiagnostic('terminal.close_requested', terminal, 'user_close', 'operation-one')
    const payload = mocks.invoke.mock.calls[0][2]
    expect(payload.event).toMatchObject({ terminalId: 'tab-one', ptyId: 'old-pty', source: 'user_close', operationId: 'operation-one' })
    expect(JSON.stringify(payload)).not.toMatch(/private-command|private-env-value|private-name/)
  })

  it('exports local evidence when the remote is unavailable without echoing sensitive errors', async () => {
    mocks.invoke.mockImplementation((_label: string, command: string) => {
      if (command === 'terminal_diagnostic_log') return Promise.resolve('{"event":"local-evidence"}')
      if (command === 'ssh_terminal_diagnostic_log') return Promise.reject(new Error('secret-token-in-transport-error'))
      return Promise.resolve('')
    })
    const exported = await collectTerminalDiagnostics(terminal, 'ssh://conn/home/app')
    expect(exported).toContain('local-evidence')
    expect(exported).toContain('"section":"remote","available":false')
    expect(exported).not.toMatch(/private-command|private-env-value|secret-token/)
    expect(mocks.invoke).not.toHaveBeenCalledWith(expect.anything(), 'ssh_create_terminal', expect.anything())
  })
})
