// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RemoteConnectionsManager from './RemoteConnectionsManager'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { isProjectRestricted, isProjectTrusted, pushTrustedRootsToNative, trustProject } from '../lib/workspaceTrust'
import type { SshConnection } from '../types'

const {
  alive, confirmDialog, getSshServerEnabled, invoke, listServerStates, loadConnections, listRoots,
  testConnection, probeHost, saveConnection, switchMode, reconnect,
} = vi.hoisted(() => ({
  alive: vi.fn(),
  confirmDialog: vi.fn(),
  getSshServerEnabled: vi.fn(),
  invoke: vi.fn(),
  listServerStates: vi.fn(),
  loadConnections: vi.fn(),
  testConnection: vi.fn(),
  listRoots: vi.fn(),
  probeHost: vi.fn(),
  saveConnection: vi.fn(),
  switchMode: vi.fn(),
  reconnect: vi.fn(),
}))

vi.mock('../lib/sshWorkspace', async () => ({
  ...await vi.importActual<typeof import('../lib/sshWorkspace')>('../lib/sshWorkspace'),
  isSshConnectionAlive: alive,
  listSshWorkspaceRoots: listRoots,
  listSshServerStates: listServerStates,
  testSshConnection: testConnection,
  openSshSession: vi.fn(),
  probeSshHost: probeHost,
  disconnectSshSession: vi.fn(async () => {}),
  switchSshConnectionMode: switchMode,
  reconnectSshConnection: reconnect,
}))
vi.mock('../lib/sshServerSettings', () => ({ getSshServerEnabled }))
vi.mock('../lib/tauri', async () => ({
  ...await vi.importActual<typeof import('../lib/tauri')>('../lib/tauri'),
  isTauri: () => false,
  safeInvoke: invoke,
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../lib/runtimeCapabilities', () => ({ hasBackend: () => true }))

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
    listRoots.mockResolvedValue([])
    localStorage.clear()
    invoke.mockResolvedValue(undefined)
    testConnection.mockReset().mockResolvedValue({fingerprint:'SHA256:known',homePath:'/home/dev'})
    probeHost.mockResolvedValue('SHA256:known')
    saveConnection.mockResolvedValue(undefined)
    switchMode.mockResolvedValue(undefined)
    reconnect.mockReset().mockResolvedValue(undefined)
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
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '测试连接' })).not.toBeDisabled())
  }

  it('creates a Server connection despite a legacy global SSH default, keeping compatibility collapsed', async () => {
    render(<RemoteConnectionsManager />)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByRole('button', { name: '高级' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('checkbox', { name: '兼容模式（SSH 直连）' })).toBeNull()

    await testNewConnection()
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ mode: 'server' }))
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
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ssh' }))
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
    expect(invoke.mock.calls.some(call => call[1] === 'ssh_server_restart')).toBe(false)
  })

  it('creates a standalone Agent connection through pairing without testing SSH', async () => {
    invoke.mockImplementation(async (_action, command) => {
      if (command === 'direct_agent_info') return null
      if (command === 'direct_agent_probe') return { certificateFingerprint: 'SHA256:tls' }
      if (command === 'direct_agent_test') return { version: 'test', protocol: 1 }
      return undefined
    })
    render(<RemoteConnectionsManager />)
    fireEvent.click(screen.getByRole('button', { name: '新建 Agent 直连' }))
    expect(screen.queryByLabelText('用户名')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: '导入配对信息' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '导入配对信息' }))
    fireEvent.change(screen.getByLabelText('配对 JSON'), { target: { value: JSON.stringify({ host: '192.168.252.107', port: 48763, certificateFingerprint: 'SHA256:tls', token: 'transient-token' }) } })
    fireEvent.click(screen.getByRole('button', { name: '应用配对信息' }))
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并启用直连' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存并启用直连' }))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.252.107', username: 'Agent', auth_kind: 'password', host_key_fingerprint: 'SHA256:tls', mode: 'server' })))
    expect(testConnection).not.toHaveBeenCalled()
    expect(probeHost).not.toHaveBeenCalled()
  })

  it('labels a saved standalone Agent endpoint without showing SSH credential fields or a blind SSH fallback', async () => {
    useProjectStore.setState({ sshConnections: [{ ...connection('server'), username: 'Agent', auth_kind: 'password', host_key_fingerprint: 'SHA256:tls' }] })
    useUIStore.setState({ remoteConnectionsCreating: false })
    invoke.mockResolvedValue({ enabled: true, host: 'example.test', port: 48763, certificateFingerprint: 'SHA256:tls', tokenSaved: true, previousPorts: [] })
    render(<RemoteConnectionsManager />)
    expect(await screen.findByText('此连接仅配置 Agent 直连；如需 SSH，请单独新建 SSH 连接。')).toBeVisible()
    expect(screen.getByText('example.test:48763 · TLS')).toBeVisible()
    expect(screen.queryByLabelText('用户名')).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复 SSH 连接' })).toBeNull()
    expect(screen.queryByRole('button', { name: '测试 SSH 配置' })).toBeNull()
  })

  it('retains standalone identity after pairing with a changed certificate and port', async () => {
    const saved = { ...connection('server'), username: 'Agent', auth_kind: 'password' as const, host_key_fingerprint: 'old-tls' }
    let profile = { enabled: true, host: 'example.test', port: 48763, certificateFingerprint: 'old-tls', tokenSaved: true, previousPorts: [] as number[] }
    useProjectStore.setState({ sshConnections: [saved] })
    useUIStore.setState({ remoteConnectionsCreating: false })
    invoke.mockImplementation(async (_action, command, args) => {
      if (command === 'direct_agent_info') return profile
      if (command === 'direct_agent_probe') return { certificateFingerprint: 'new-tls' }
      if (command === 'direct_agent_test') return { version: 'test', protocol: 1 }
      if (command === 'direct_agent_save') profile = { ...profile, ...args, tokenSaved: true }
      return undefined
    })
    saveConnection.mockImplementation(async next => { useProjectStore.setState({ sshConnections: [next] }) })
    render(<RemoteConnectionsManager />)
    await screen.findByText('此连接仅配置 Agent 直连；如需 SSH，请单独新建 SSH 连接。')
    fireEvent.click(screen.getByRole('button', { name: 'Agent 端口直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '导入配对信息' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '导入配对信息' }))
    fireEvent.change(screen.getByLabelText('配对 JSON'), { target: { value: JSON.stringify({ host: 'other.test', port: 51234, certificateFingerprint: 'new-tls', token: 'new-token' }) } })
    fireEvent.click(screen.getByRole('button', { name: '应用配对信息' }))
    fireEvent.click(screen.getByRole('button', { name: '测试直连' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并启用直连' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存并启用直连' }))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({ host: 'other.test', host_key_fingerprint: 'new-tls', username: 'Agent' })))
    expect(await screen.findByText('other.test:51234 · TLS')).toBeVisible()
    expect(screen.queryByRole('button', { name: '恢复 SSH 连接' })).toBeNull()
    expect(screen.queryByLabelText('用户名')).toBeNull()
  })
  it('persists revocation as restricted so subsequent trust synchronization cannot regrant it', async () => {
    const project = {id:'p1',name:'app',path:'ssh://c1/home/app',kind:'ssh' as const,created_at:1,last_opened_at:1}
    trustProject(project)
    useProjectStore.setState({sshConnections:[connection('server')],projects:[project]})
    useUIStore.setState({remoteConnectionsCreating:false})
    listRoots.mockResolvedValue([{rootUri:project.path,trusted:true}])
    render(<RemoteConnectionsManager />)
    fireEvent.click(await screen.findByRole('button',{name:'撤销信任'}))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('撤销 SSH 工作区信任','ssh_set_workspace_trust',{rootUri:project.path,trusted:false}))
    expect(isProjectTrusted(project)).toBe(false)
    expect(isProjectRestricted(project)).toBe(true)
    await pushTrustedRootsToNative([project])
    expect(invoke).toHaveBeenCalledWith('同步 SSH 项目信任状态','ssh_set_workspace_trust',{rootUri:project.path,trusted:false})
  })

  it('saves a tested username change when the host fingerprint remains the same, without opening a workspace session', async () => {
    const {openSshSession} = await import('../lib/sshWorkspace')
    useProjectStore.setState({sshConnections:[connection('server')]})
    useUIStore.setState({remoteConnectionsCreating:false})
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'newuser'}})
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button',{name:'测试连接'})).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({username:'newuser',host_key_fingerprint:'SHA256:known'})))
    expect(testConnection).toHaveBeenCalledWith(expect.objectContaining({username:'newuser',id:expect.not.stringMatching(/^c1$/)}))
    expect(openSshSession).not.toHaveBeenCalled()
  })

  it.each(['主机','端口','用户名','私钥文件（可选）'])('invalidates a new connection verification when %s changes', async label => {
    render(<RemoteConnectionsManager />)
    await testNewConnection()
    const value = label === '端口' ? '2222' : 'changed'
    fireEvent.change(screen.getByLabelText(label),{target:{value}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    expect(screen.getByText('请先「测试连接」确认主机指纹后再保存。')).toBeTruthy()
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it('keeps verified authentication valid when only its display name changes', async () => {
    render(<RemoteConnectionsManager />)
    await testNewConnection()
    fireEvent.change(screen.getByLabelText('连接名称'),{target:{value:'Renamed'}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({name:'Renamed'})))
  })

  it('does not require a connection test to rename an existing saved connection', async () => {
    useProjectStore.setState({sshConnections:[connection('server')]})
    useUIStore.setState({remoteConnectionsCreating:false})
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    fireEvent.change(screen.getByLabelText('连接名称'),{target:{value:'Renamed'}})
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({name:'Renamed'})))
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('ignores a completed test after its target was edited, including an edit back to the original value', async () => {
    let finish!: (value: {fingerprint:string,homePath:string}) => void
    testConnection.mockImplementationOnce(() => new Promise(resolve => {finish=resolve}))
    render(<RemoteConnectionsManager />)
    fireEvent.change(screen.getByLabelText('主机'),{target:{value:'example.test'}})
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'dev'}})
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('主机'),{target:{value:'other.test'}})
    fireEvent.change(screen.getByLabelText('主机'),{target:{value:'example.test'}})
    await act(async () => finish({fingerprint:'SHA256:known',homePath:'/home/dev'}))
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    expect(saveConnection).not.toHaveBeenCalled()
    expect(screen.getByText('请先「测试连接」确认主机指纹后再保存。')).toBeTruthy()
  })

  it('does not confirm or authenticate a probe that finished after switching connections', async () => {
    let finish!: (fingerprint:string) => void
    probeHost.mockImplementationOnce(() => new Promise(resolve => {finish=resolve}))
    useProjectStore.setState({sshConnections:[connection('server'),{...connection('server'),id:'c2',name:'Other',host:'other.test'}]})
    useUIStore.setState({remoteConnectionsCreating:false})
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await waitFor(() => expect(probeHost).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button',{name:/Other/}))
    await screen.findByDisplayValue('other.test')
    await act(async () => finish('SHA256:changed'))
    expect(confirmDialog).not.toHaveBeenCalled()
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('applies a verified live configuration only after reconnect confirmation and saving', async () => {
    useProjectStore.setState({sshConnections:[connection('server')]})
    useUIStore.setState({remoteConnectionsCreating:false})
    alive.mockResolvedValue(true)
    render(<RemoteConnectionsManager />)
    await screen.findByDisplayValue('example.test')
    await screen.findByRole('button',{name:'断开连接'})
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'newuser'}})
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button',{name:'测试连接'})).not.toBeDisabled())
    confirmDialog.mockResolvedValue(false)
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({title:'保存并重新连接'})))
    expect(saveConnection).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
    confirmDialog.mockResolvedValue(true)
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith('c1'))
    expect(saveConnection.mock.invocationCallOrder[0]).toBeLessThan(reconnect.mock.invocationCallOrder[0])
    expect(switchMode).not.toHaveBeenCalled()
  })

  it('does not allow a confirmed fingerprint to authorize saving after authentication fails', async () => {
    testConnection.mockRejectedValueOnce(new Error('authentication failed'))
    render(<RemoteConnectionsManager />)
    fireEvent.change(screen.getByLabelText('主机'),{target:{value:'example.test'}})
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'dev'}})
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await screen.findByText('Error: authentication failed')
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    expect(saveConnection).not.toHaveBeenCalled()
  })

  it.each(['认证方式','密码（测试连接用，不会保存）','私钥口令（如有，仅本次会话）','兼容模式（SSH 直连）'])('invalidates verified configuration after editing %s', async label => {
    render(<RemoteConnectionsManager />)
    await testNewConnection()
    if (label === '兼容模式（SSH 直连）') {
      fireEvent.click(screen.getByRole('button',{name:'高级'}))
      fireEvent.click(screen.getByLabelText(label))
    } else {
      fireEvent.change(screen.getByLabelText(label),{target:{value:label === '认证方式' ? 'password' : 'new-secret'}})
    }
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    expect(saveConnection).not.toHaveBeenCalled()
    expect(screen.getByText('请先「测试连接」确认主机指纹后再保存。')).toBeTruthy()
  })

  it('keeps a newer test busy when an older invalidated test fails', async () => {
    let failOld!: (reason:Error) => void
    let finishNew!: (value:{fingerprint:string,homePath:string}) => void
    testConnection.mockImplementationOnce(() => new Promise((_resolve,reject) => {failOld=reject}))
      .mockImplementationOnce(() => new Promise(resolve => {finishNew=resolve}))
    render(<RemoteConnectionsManager />)
    fireEvent.change(screen.getByLabelText('主机'),{target:{value:'example.test'}})
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'dev'}})
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('用户名'),{target:{value:'newuser'}})
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}))
    await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(2))
    await act(async () => failOld(new Error('old failure')))
    expect(screen.queryByText('Error: old failure')).toBeNull()
    expect(screen.getByRole('button',{name:'正在连接…'})).toBeDisabled()
    await act(async () => finishNew({fingerprint:'SHA256:known',homePath:'/home/newuser'}))
    fireEvent.click(screen.getByRole('button',{name:'保存'}))
    await waitFor(() => expect(saveConnection).toHaveBeenCalledWith(expect.objectContaining({username:'newuser'})))
  })

})
