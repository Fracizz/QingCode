// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@tauri-apps/plugin-dialog'
import CreateProjectDialog from './CreateProjectDialog'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  browseSshDirectory,
  isSshConnectionAlive,
  openSshSession,
  probeSshHost,
  SSH_CONNECTIONS_CHANGED_EVENT,
} from '../lib/sshWorkspace'
import type { SshConnection } from '../types'
import { confirmDialog } from '../store/confirmStore'

vi.mock('../store/confirmStore', () => ({ confirmDialog: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

vi.mock('../lib/sshWorkspace', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/sshWorkspace')>()
  return {
    ...actual,
    openSshSession: vi.fn(),
    probeSshHost: vi.fn(),
    isSshConnectionAlive: vi.fn(),
    browseSshDirectory: vi.fn(),
  }
})

const keyHost: SshConnection = {
  id: 'c-key',
  name: 'dev-box',
  host: '10.0.0.2',
  port: 22,
  username: 'root',
  auth_kind: 'privateKey',
  host_key_fingerprint: 'SHA256:key',
  created_at: 1,
  updated_at: 1,
}
const passwordHost: SshConnection = {
  ...keyHost,
  id: 'c-pwd',
  name: 'pwd-box',
  host: '10.0.0.3',
  auth_kind: 'password',
}

const initialProjectState = useProjectStore.getState()
const initialUIState = useUIStore.getState()

function openSourceMenu() {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return screen.getByRole('menu', { name: '源文件夹位置' })
}

describe('CreateProjectDialog', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset()
    vi.mocked(confirmDialog).mockReset().mockResolvedValue(true)
    vi.mocked(probeSshHost).mockReset().mockResolvedValue('SHA256:imported')
    vi.mocked(openSshSession).mockReset().mockResolvedValue({
      fingerprint: 'SHA256:key',
      homePath: '/root',
    })
    vi.mocked(isSshConnectionAlive).mockReset().mockResolvedValue(false)
    vi.mocked(browseSshDirectory).mockReset().mockResolvedValue({
      path: '/root',
      entries: [{ name: 'app', path: '/root/app', is_dir: true }],
    })
    useProjectStore.setState({
      sshConnections: [keyHost, passwordHost],
      loadSshConnections: vi.fn().mockResolvedValue(undefined),
      addProject: vi.fn().mockResolvedValue(true),
      addSshProject: vi.fn().mockResolvedValue(true),
      saveSshConnection: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useProjectStore.setState(initialProjectState, true)
    useUIStore.setState(initialUIState, true)
  })

  it.each([true, false])('asks for host trust before opening an imported connection (accepted: %s)', async accepted => {
    useProjectStore.setState({ sshConnections: [{ ...keyHost, host_key_fingerprint: '' }] })
    vi.mocked(confirmDialog).mockResolvedValue(accepted)
    vi.mocked(openSshSession).mockResolvedValue({ fingerprint: 'SHA256:imported', homePath: '/root' })
    render(<CreateProjectDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.click(within(openSourceMenu()).getByRole('menuitemradio', { name: /dev-box/ }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ detail: 'SHA256:imported' })))
    if (accepted) {
      await waitFor(() => expect(useProjectStore.getState().saveSshConnection).toHaveBeenCalledWith(expect.objectContaining({ host_key_fingerprint: 'SHA256:imported' })))
      expect(openSshSession).toHaveBeenCalledWith(expect.objectContaining({ hostKeyFingerprint: 'SHA256:imported' }))
    } else {
      expect(openSshSession).not.toHaveBeenCalled()
      expect(useProjectStore.getState().saveSshConnection).not.toHaveBeenCalled()
    }
  })

  it('creates a local project from the chosen folder with a custom name', async () => {
    vi.mocked(open).mockResolvedValue('D:\\code\\demo')
    const onCreated = vi.fn()
    render(<CreateProjectDialog open onClose={vi.fn()} onCreated={onCreated} />)

    expect(screen.getByRole('button', { name: '创建项目' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '在此电脑上选择文件夹' }))
    expect(await screen.findByText('D:\\code\\demo')).toBeInTheDocument()
    expect(screen.getByLabelText('项目名称')).toHaveAttribute('placeholder', 'demo')

    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '演示' } })
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() =>
      expect(useProjectStore.getState().addProject).toHaveBeenCalledWith('D:\\code\\demo', '演示')
    )
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('lists only saved hosts under remote devices even on Windows', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    useProjectStore.setState({ sshConnections: [{ ...keyHost, name: 'WSL' }, passwordHost] })
    render(<CreateProjectDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
    const menu = openSourceMenu()
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveTextContent('此电脑')
    expect(menu).toHaveTextContent('远程设备')
    expect(within(menu).getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      '此电脑',
      'WSLroot@10.0.0.2',
      'pwd-boxroot@10.0.0.3',
      '添加远程主机',
      '管理远程连接…',
    ])
    expect(screen.getByRole('menuitemradio', { name: '添加远程主机' })).toBeInTheDocument()
  })

  it('connects a key-based host directly and adds the selected remote folder', async () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
    openSourceMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /dev-box/ }))

    fireEvent.click(await screen.findByRole('option', { name: 'app' }))
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
    await waitFor(() =>
      expect(useProjectStore.getState().addSshProject).toHaveBeenCalledWith(
        keyHost,
        '/root/app',
        '',
        {}
      )
    )
  })

  it('asks for the session password before connecting a password host', async () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
    openSourceMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /pwd-box/ }))

    const input = await screen.findByLabelText('密码（本次会话，不会保存）')
    expect(openSshSession).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    await screen.findByRole('option', { name: 'app' })
    expect(vi.mocked(openSshSession).mock.calls[0]?.[0]).toMatchObject({
      id: 'c-pwd',
      password: 'secret',
    })
  })

  it('opens the connection manager to add a host and selects it once saved', async () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
    openSourceMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: '添加远程主机' }))
    expect(useUIStore.getState()).toMatchObject({
      remoteConnectionsOpen: true,
      remoteConnectionsCreating: true,
    })

    const added: SshConnection = { ...keyHost, id: 'c-new', name: 'fresh-box' }
    vi.mocked(isSshConnectionAlive).mockResolvedValue(true)
    act(() => {
      useProjectStore.setState({ sshConnections: [keyHost, passwordHost, added] })
      window.dispatchEvent(new Event(SSH_CONNECTIONS_CHANGED_EVENT))
    })

    await screen.findByRole('option', { name: 'app' })
    expect(browseSshDirectory).toHaveBeenCalledWith('c-new', '/root')
  })
})
