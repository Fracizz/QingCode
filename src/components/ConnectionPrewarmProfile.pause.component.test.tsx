// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { saveConnectionPrewarmProfile } from '../lib/terminal/connectionPrewarmProfile'
import { trustTerminalProfile } from '../lib/terminal/terminalProfileTrust'
import { saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import type { Project } from '../types'
import { useProjectStore } from '../store/projectStore'
import ConnectionPrewarmProfile from './ConnectionPrewarmProfile'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../lib/tauri', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  safeInvoke: invoke,
}))

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
})

it('shows why the remote CLI prewarm paused, e.g. the CLI is not installed', async () => {
  const profile: TerminalProfile = { id: 'ai', name: 'Claude', shell: 'pwsh', command: 'claude' }
  saveTerminalProfileSettings({ profiles: [profile], defaultProfileId: null, defaultShell: profile.shell })
  trustTerminalProfile(profile)
  saveConnectionPrewarmProfile('a', profile)
  const root = 'ssh://a/D:/code/app'
  useProjectStore.setState({ projects: [{ id: 'p', name: 'p', path: root, created_at: 0, last_opened_at: 0 } as Project] })
  invoke.mockResolvedValue({ target: 1, profile: { target: 1, reason: 'cli_not_installed' } })
  render(<ConnectionPrewarmProfile connectionId="a" />)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('未找到 claude 命令'))
  expect(invoke).toHaveBeenCalledWith(expect.any(String), 'shell_prewarm_status', { cwd: root })
})

it('stays quiet when the CLI prewarm runs normally or is not selected', async () => {
  const root = 'ssh://a/D:/code/app'
  useProjectStore.setState({ projects: [{ id: 'p', name: 'p', path: root, created_at: 0, last_opened_at: 0 } as Project] })
  invoke.mockResolvedValue({ target: 1, profile: { target: 1, reason: null } })
  render(<ConnectionPrewarmProfile connectionId="a" />)
  await Promise.resolve()
  expect(invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole('status')).toBeNull()
})
