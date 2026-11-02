// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshReconnectDialog from './SshReconnectDialog'
import type { Project } from '../types'

const { readConnection, readDirect, connect, switchProject, manage } = vi.hoisted(() => ({ readConnection: vi.fn(), readDirect: vi.fn(), connect: vi.fn(), switchProject: vi.fn(), manage: vi.fn() }))
vi.mock('../lib/projectRepository', () => ({ getSshConnection: readConnection, upsertSshConnection: vi.fn() }))
vi.mock('../lib/directAgent', async () => ({ ...await vi.importActual('../lib/directAgent'), directAgentApi: { info: readDirect, manage } }))
vi.mock('../lib/sshWorkspace', async () => ({ ...await vi.importActual('../lib/sshWorkspace'), connectSshWorkspace: connect, SSH_RECONNECT_REQUEST_EVENT: 'qingcode:ssh-reconnect-request' }))
vi.mock('../store/projectStore', () => ({ useProjectStore: Object.assign((select: (state: { sshConnections: never[] }) => unknown) => select({ sshConnections: [] }), { getState: () => ({ switchProject }) }) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

const project: Project = { id: 'p1', name: 'Agent project', kind: 'ssh', connection_id: 'c1', path: 'ssh://c1/D:/code/app', root_path: '/D:/code/app', created_at: 1, last_opened_at: 1 }

describe('Agent workspace reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readConnection.mockResolvedValue({ id: 'c1', host: 'host.test', port: 22, username: 'Agent', auth_kind: 'password', host_key_fingerprint: 'TLS:paired' })
    readDirect.mockResolvedValue({ enabled: true, host: 'host.test', port: 48763, certificateFingerprint: 'TLS:paired', tokenSaved: true, previousPorts: [] })
    manage.mockResolvedValue({ enabled: true, host: 'host.test', port: 48763, autoStart: true })
    connect.mockResolvedValue(undefined)
    switchProject.mockResolvedValue(true)
  })

  it('reconnects through stored native Server credentials without an SSH password input', async () => {
    render(<SshReconnectDialog />)
    act(() => window.dispatchEvent(new CustomEvent('qingcode:ssh-reconnect-request', { detail: project })))
    expect(await screen.findByText('重新连接 Server 项目')).toBeVisible()
    expect(screen.getByText('host.test:48763 · TLS')).toBeVisible()
    expect(screen.queryByLabelText('密码（仅本次会话）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith(project, expect.objectContaining({ username: 'Agent' }), {}))
    expect(switchProject).toHaveBeenCalledWith(project)
  })

  it('starts Server through an explicit SSH action then reconnects the original direct workspace', async () => {
    readConnection.mockResolvedValue({ id: 'c1', name: 'WinDev', host: 'host.test', port: 28822, username: 'Administrator', auth_kind: 'password', host_key_fingerprint: 'SHA256:ssh' })
    render(<SshReconnectDialog />)
    act(() => window.dispatchEvent(new CustomEvent('qingcode:ssh-reconnect-request', { detail: project })))
    fireEvent.click(await screen.findByRole('button', { name: '通过 SSH 启动 Server' }))
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ autoStart: true, start: true })))
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(switchProject).toHaveBeenCalledWith(project)
  })

  it('retains the existing password prompt for ordinary SSH profiles', async () => {
    readDirect.mockResolvedValue(null)
    render(<SshReconnectDialog />)
    act(() => window.dispatchEvent(new CustomEvent('qingcode:ssh-reconnect-request', { detail: project })))
    expect(await screen.findByLabelText('密码（仅本次会话）')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    expect(screen.getByText('请输入 SSH 密码。')).toBeVisible()
    expect(connect).not.toHaveBeenCalled()
  })
})
