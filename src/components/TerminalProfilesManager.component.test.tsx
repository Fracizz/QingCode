// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { connectionDefaultProfileId } from '../lib/terminal/connectionDefaultProfile'
import { loadTerminalProfileSettings, saveTerminalProfileSettings, type TerminalProfile } from '../lib/terminal/terminalProfiles'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import type { SshConnection } from '../types'
import TerminalProfilesManager from './TerminalProfilesManager'

const connection = (id: string, name: string): SshConnection => ({
  id, name, host: `${id}.test`, port: 22, username: 'dev', auth_kind: 'password',
  host_key_fingerprint: 'fp', created_at: 1, updated_at: 1,
})
const claude: TerminalProfile = { id: 'claude', name: 'Claude', shell: 'bash', command: 'claude' }
const deploy: TerminalProfile = { id: 'deploy', name: 'Deploy', shell: 'bash', command: 'deploy', scope: 'win' }

beforeEach(() => {
  localStorage.clear()
  saveTerminalProfileSettings({ profiles: [claude, deploy], defaultProfileId: null, defaultShell: 'bash' })
  useProjectStore.setState({ sshConnections: [connection('win', 'WinDev'), connection('lin', 'Linux')] })
  useUIStore.setState({ terminalProfilesManagerOpen: true })
})

const group = (key: string) => document.querySelector(`[data-profile-group="${key}"]`) as HTMLElement

it('groups profiles by remote connection', () => {
  render(<TerminalProfilesManager />)
  expect(within(group('common')).getByText('Claude')).toBeTruthy()
  expect(within(group('common')).getByText('普通终端')).toBeTruthy()
  expect(within(group('ssh:win')).getByText('Deploy')).toBeTruthy()
  expect(within(group('ssh:lin')).getByText('暂无配置，可添加或从其他分类导入。')).toBeTruthy()
})

it('copies a profile to another connection and imports one into a group', () => {
  render(<TerminalProfilesManager />)
  fireEvent.click(screen.getByRole('button', { name: '复制终端配置「Claude」' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /复制到「Linux」/ }))
  const copied = loadTerminalProfileSettings().profiles.find(p => p.scope === 'lin')
  expect(copied).toMatchObject({ name: 'Claude', command: 'claude', shell: 'bash' })
  expect(copied!.id).not.toBe('claude')

  fireEvent.click(screen.getByRole('button', { name: '导入终端配置到「本机」' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /WinDev \/ Deploy/ }))
  expect(loadTerminalProfileSettings().profiles.find(p => p.scope === 'local')).toMatchObject({ name: 'Deploy', command: 'deploy' })
  // 原配置保留在原分类。
  expect(loadTerminalProfileSettings().profiles.find(p => p.id === 'deploy')?.scope).toBe('win')
})

it('sets the connection default from a connection group and toggles it back', () => {
  render(<TerminalProfilesManager />)
  const button = screen.getByRole('button', { name: '将「Deploy」设为此连接的默认终端' })
  fireEvent.click(button)
  expect(connectionDefaultProfileId('win')).toBe('deploy')
  expect(loadTerminalProfileSettings().defaultProfileId).toBeNull()
  fireEvent.click(button)
  expect(connectionDefaultProfileId('win')).toBeNull()
})
