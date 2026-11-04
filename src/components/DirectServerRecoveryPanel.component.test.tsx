// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DirectServerRecoveryPanel from './DirectServerRecoveryPanel'
import type { DirectAgentApi, DirectAgentInfo } from '../lib/directAgent'
import type { SshConnection } from '../types'

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }))
vi.mock('../store/uiStore', () => ({ useUIStore: { getState: () => ({ openRemoteConnections: configure }) } }))
vi.mock('../store/projectStore', () => ({ useProjectStore: (select: (state: { sshConnections: SshConnection[] }) => unknown) => select({ sshConnections: [] }) }))
vi.mock('../lib/sshWorkspace', () => ({ sshSecretsFor: () => ({}), sshRuntimeConfig: (connection: SshConnection, secrets: object) => ({ id: connection.id, host: connection.host, hostKeyFingerprint: connection.host_key_fingerprint, ...secrets }) }))
const ssh: SshConnection = { id: 'ssh', host: 'host.test', name: 'WinDev', username: 'admin', port: 28822, auth_kind: 'password', host_key_fingerprint: 'SHA256:ssh', created_at: 1, updated_at: 1 }
const info: DirectAgentInfo = { enabled: true, host: 'host.test', port: 48763, certificateFingerprint: 'a'.repeat(64), tokenSaved: true, previousPorts: [] }
function setup(connections = [ssh], value = info) {
  const manage = vi.fn().mockResolvedValue({ ...value, autoStart: true })
  const started = vi.fn()
  const updated = vi.fn()
  const api = { manage } as unknown as DirectAgentApi
  const view = render(<DirectServerRecoveryPanel connectionId="paired" info={value} connections={connections} api={api} onStarted={started} onUpdated={updated} />)
  return { manage, started, updated, ...view }
}

describe('paired Server startup recovery', () => {
  beforeEach(() => vi.clearAllMocks())
  it('defaults startup on and only reconnects after explicit authenticated SSH startup completes', async () => {
    const { manage, started } = setup()
    let finish!: (value: DirectAgentInfo) => void
    manage.mockReturnValue(new Promise(resolve => { finish = resolve }))
    expect(screen.getByRole('switch', { name: '开机自启 Server' })).toBeChecked()
    expect(manage).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('SSH 密码'), { target: { value: 'transient' } })
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 启动 Server' }))
    expect(manage).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'paired', sshConnectionId: 'ssh', autoStart: true, start: true, config: expect.objectContaining({ password: 'transient', hostKeyFingerprint: 'SHA256:ssh' }) }))
    expect(started).not.toHaveBeenCalled()
    expect(screen.getByRole('switch')).toBeDisabled()
    await act(async () => { finish({ ...info, autoStart: true }) })
    expect(started).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('SSH 密码')).toHaveValue('')
  })
  it('can disable startup without starting or reconnecting the running gateway', async () => {
    const { manage, started } = setup()
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: '应用自启设置' }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ start: false, autoStart: false })))
    expect(started).not.toHaveBeenCalled()
  })
  it('retains a saved off preference, and offers SSH setup plus manual commands for unmatched hosts', () => {
    const { manage } = setup([{ ...ssh, host: 'other.test' }], { ...info, autoStart: false })
    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.queryByRole('button', { name: '通过 SSH 启动 Server' })).toBeNull()
    fireEvent.click(screen.getByText('远端手动启动命令'))
    expect(screen.getByText(/qingcode-server direct --port 48763/)).toHaveTextContent('startup disable')
    fireEvent.click(screen.getByRole('button', { name: '配置 SSH 连接' }))
    expect(configure).toHaveBeenCalledTimes(1)
    expect(manage).not.toHaveBeenCalled()
  })
  it('does not reconnect after a startup failure or use another host implicitly', async () => {
    const { manage, started } = setup()
    manage.mockRejectedValue(new Error('[direct:startup] private diagnostics'))
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 启动 Server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('管理员权限')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private diagnostics')
    expect(started).not.toHaveBeenCalled()
  })
  it('ignores completion after the target panel unmounts', async () => {
    const { manage, started, updated, unmount } = setup()
    let finish!: (value: DirectAgentInfo) => void
    manage.mockReturnValue(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: '通过 SSH 启动 Server' }))
    unmount()
    await act(async () => { finish(info) })
    expect(started).not.toHaveBeenCalled()
    expect(updated).not.toHaveBeenCalled()
  })
})
