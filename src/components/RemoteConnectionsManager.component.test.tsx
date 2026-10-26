// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RemoteConnectionsManager from './RemoteConnectionsManager'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import type { SshConnection } from '../types'

const {
  alive, confirmDialog, getSshServerEnabled, invoke, listServerStates, loadConnections,
  openSession, probeHost, saveConnection, switchMode,
} = vi.hoisted(() => ({
  alive: vi.fn(),
  confirmDialog: vi.fn(),
  getSshServerEnabled: vi.fn(),
  invoke: vi.fn(),
  listServerStates: vi.fn(),
  loadConnections: vi.fn(),
  openSession: vi.fn(),
  probeHost: vi.fn(),
  saveConnection: vi.fn(),
  switchMode: vi.fn(),
}))

vi.mock('../lib/sshWorkspace', async () => ({
  ...await vi.importActual<typeof import('../lib/sshWorkspace')>('../lib/sshWorkspace'),
  isSshConnectionAlive: alive,
  listSshWorkspaceRoots: vi.fn(async () => []),
  listSshServerStates: listServerStates,
  openSshSession: openSession,
  probeSshHost: probeHost,
  disconnectSshSession: vi.fn(async () => {}),
  switchSshConnectionMode: switchMode,
}))
vi.mock('../lib/sshServerSettings', () => ({ getSshServerEnabled }))
vi.mock('../lib/tauri', async () => ({
  ...await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri'),
  isTauri: () => false,
  safeInvoke: invoke,
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const connection = (mode?: SshConnection['mode']): SshConnection => ({
  id: 'c1',
  name: 'Remote',
  host: 'example.test',
  port: 22,
  username: 'dev',
  auth_kind: 'privateKey',
  host_key_fingerprint: 'SHA256:known',
  created_at: 1,
  mode,
})

describe('remote connection compatibility settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    alive.mockResolvedValue(false)
    confirmDialog.mockResolvedValue(true)
    // A legacy installation may have explicitly disabled the server globally.
    getSshServerEnabled.mockReturnValue(false)
    loadConnections.mockResolvedValue(undefined)
    listServerStates.mockResolvedValue([])
    invoke.mockResolvedValue(undefined)
    openSession.mockResolvedValue(undefined)
    probeHost.mockResolvedValue('SHA256:known')
    saveConnection.mockResolvedValue(undefined)
    switchMode.mockResolvedValue(undefined)
    useProjectStore.setState({
      sshConnections: [],
      projects: [],
      loadSshConnections: loadConnections,
      saveSshConnection: saveConnection,
      pushToast: vi.fn(),
    })
    useUIStore.setState({ remoteConnectionsCreating: true })
  })

  async function testNewConnection() {
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: 'example.test' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'dev' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '测试连接' })).not.toBeDisabled())
  }

  it('creates a Server connection despite a legacy global SSH default, keeping compatibility collapsed', async () => {
    render(<RemoteConnectionsManager />)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByRole('button', { name: '高级' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('checkbox', { name: '兼容模式（SSH 直连）' })).toBeNull()

    await testNewConnection()
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'server' }))
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '确认 SSH 主机指纹' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({ mode: 'server' })))
  })

  it('requires an explicit advanced choice to create a compatibility connection', async () => {
    render(<RemoteConnectionsManager />)
    fireEvent.click(screen.getByRole('button', { name: '高级' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '兼容模式（SSH 直连）' }))
    expect(screen.getByText('兼容模式已启用')).toBeTruthy()
    await testNewConnection()
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ssh' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ssh' })))
  })

  it.each(['ssh', undefined] as const)('preserves an existing %s connection and exposes its compatibility setting', async mode => {
    useProjectStore.setState({ sshConnections: [connection(mode)] })
    useUIStore.setState({ remoteConnectionsCreating: false })
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    expect(screen.getByRole('checkbox', { name: '兼容模式（SSH 直连）' })).toBeChecked()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(saveConnection).not.toHaveBeenCalled()
    expect(switchMode).not.toHaveBeenCalled()
  })

  it('keeps an explicit Server connection in Server mode when the legacy default is false', async () => {
    useProjectStore.setState({ sshConnections: [connection('server')] })
    useUIStore.setState({ remoteConnectionsCreating: false })
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    expect(screen.getByRole('button', { name: '高级' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: '高级' }))
    expect(screen.getByRole('checkbox', { name: '兼容模式（SSH 直连）' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('confirms a live compatibility change and leaves the connection untouched when cancelled', async () => {
    useProjectStore.setState({ sshConnections: [connection('ssh')] })
    useUIStore.setState({ remoteConnectionsCreating: false })
    alive.mockResolvedValue(true)
    confirmDialog.mockResolvedValue(false)
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    await screen.findByRole('button', { name: '断开连接' })
    fireEvent.click(screen.getByRole('checkbox', { name: '兼容模式（SSH 直连）' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '更改兼容模式' })))
    expect(saveConnection).not.toHaveBeenCalled()
    expect(switchMode).not.toHaveBeenCalled()

    confirmDialog.mockResolvedValue(true)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(switchMode).toHaveBeenCalledWith('c1', 'server'))
    expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ssh' }))
  })

  it('opens installation settings from an existing connection', async () => {
    useProjectStore.setState({ sshConnections: [connection('server')] })
    useUIStore.setState({ remoteConnectionsCreating: false, remoteConnectionsOpen: true })
    render(<RemoteConnectionsManager />)
    fireEvent.click(await screen.findByRole('button', { name: '服务安装设置' }))
    expect(useUIStore.getState().remoteConnectionsOpen).toBe(false)
    expect(useUIStore.getState().settingsFocusQuery).toBe('ssh.server')
  })

  it('does not restart a service when its terminal-impact confirmation is cancelled', async () => {
    useProjectStore.setState({ sshConnections: [connection('server')] })
    useUIStore.setState({ remoteConnectionsCreating: false })
    listServerStates.mockResolvedValue([{
      connectionId: 'c1', rootUri: 'ssh://c1/home/app', connectionMode: 'server',
      phase: 'readyServer', mode: 'server', version: '0.1.13', transport: 'daemon',
    }])
    confirmDialog.mockResolvedValue(false)
    render(<RemoteConnectionsManager />)
    fireEvent.click(await screen.findByRole('button', { name: '重启远端服务' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      message: '重启会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。',
    })))
    expect(invoke).not.toHaveBeenCalled()
  })
})
