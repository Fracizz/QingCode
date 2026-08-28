// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'
import SshProjectDialog from './SshProjectDialog'
import { INTERRUPT_MODAL_Z } from './ModalOverlay'
import { useConfirmStore } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import {
  browseSshDirectory,
  disconnectSshSession,
  openSshSession,
  probeSshHost,
} from '../lib/sshWorkspace'

vi.mock('../lib/sshWorkspace', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/sshWorkspace')>()
  return {
    ...actual,
    probeSshHost: vi.fn(),
    openSshSession: vi.fn(),
    browseSshDirectory: vi.fn(),
    disconnectSshSession: vi.fn(),
  }
})

const initialProjectState = useProjectStore.getState()

function fillSshForm() {
  fireEvent.change(screen.getByLabelText('主机'), { target: { value: '192.168.1.10' } })
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'root' } })
  fireEvent.change(screen.getByLabelText('私钥文件（可选）'), {
    target: { value: 'C:\\Users\\owner\\.ssh\\id_rsa2048' },
  })
}

async function connectAndConfirm() {
  fillSshForm()
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  const confirm = await screen.findByRole('alertdialog', { name: '确认 SSH 主机指纹' })
  fireEvent.click(screen.getByRole('button', { name: '信任此主机' }))
  return confirm
}

describe('SshProjectDialog', () => {
  beforeEach(() => {
    vi.mocked(probeSshHost).mockReset()
    vi.mocked(openSshSession).mockReset()
    vi.mocked(browseSshDirectory).mockReset()
    vi.mocked(disconnectSshSession).mockReset()
    vi.mocked(probeSshHost).mockResolvedValue('SHA256:test-fingerprint')
    vi.mocked(openSshSession).mockResolvedValue({
      fingerprint: 'SHA256:test-fingerprint',
      homePath: '/root',
    })
    vi.mocked(browseSshDirectory).mockResolvedValue({
      path: '/root',
      entries: [
        { name: 'go', path: '/root/go', is_dir: true },
        { name: '.claude', path: '/root/.claude', is_dir: true },
      ],
    })
    vi.mocked(disconnectSshSession).mockResolvedValue(undefined)
    useProjectStore.setState({
      sshConnections: [],
      loadSshConnections: vi.fn().mockResolvedValue(undefined),
      saveSshConnection: vi.fn().mockResolvedValue(undefined),
      addSshProject: vi.fn().mockResolvedValue(true),
    })
  })

  afterEach(() => {
    useConfirmStore.getState().answer(false)
    useProjectStore.setState(initialProjectState, true)
  })

  it('keeps the SSH form above its own dimming backdrop', () => {
    render(<SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: '打开 SSH 项目' })
    expect(dialog.className).toMatch(/\brelative\b/)
    expect(dialog.previousElementSibling).toHaveAttribute('aria-hidden')
  })

  it('can connect with the default private key when the path is left empty', async () => {
    render(
      <>
        <SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />
        <ConfirmDialog />
      </>
    )
    fireEvent.change(screen.getByLabelText('主机'), { target: { value: 'localhost' } })
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'owner' } })
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    await waitFor(() => expect(probeSshHost).toHaveBeenCalled())
    expect(vi.mocked(probeSshHost).mock.calls[0]?.[0]).toMatchObject({
      host: 'localhost',
      username: 'owner',
      authKind: 'privateKey',
      privateKeyPath: undefined,
    })
    expect(screen.queryByText('请选择 SSH 私钥文件。')).not.toBeInTheDocument()
    expect(
      screen.queryByText('请填写主机、用户名和以 / 开头的远程项目路径。')
    ).not.toBeInTheDocument()
  })

  it('shows the host-fingerprint confirm above the SSH form', async () => {
    render(
      <>
        <SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />
        <ConfirmDialog />
      </>
    )
    fillSshForm()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    const confirm = await screen.findByRole('alertdialog', { name: '确认 SSH 主机指纹' })
    expect(confirm.closest('[class*="z-["]')?.className).toContain(INTERRUPT_MODAL_Z)
    expect(screen.getByRole('dialog', { name: '打开 SSH 项目' })).toBeInTheDocument()
  })

  it('can close while probing so the overlay does not stay locked', async () => {
    let resolveProbe: (value: string) => void = () => {}
    vi.mocked(probeSshHost).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveProbe = resolve
        })
    )
    const onClose = vi.fn()
    render(<SshProjectDialog open onClose={onClose} onAdded={vi.fn()} />)
    fillSshForm()
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    await waitFor(() => expect(probeSshHost).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledOnce()

    resolveProbe('SHA256:late')
    await waitFor(() => expect(useConfirmStore.getState().request).toBeNull())
  })

  it('opens a folder picker after the host is trusted', async () => {
    render(
      <>
        <SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />
        <ConfirmDialog />
      </>
    )
    await connectAndConfirm()

    expect(await screen.findByRole('dialog', { name: '选择远程项目' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: '.claude' })).toBeInTheDocument()
    const sourceFolder = screen.getByLabelText('源文件夹')
    expect(sourceFolder).toHaveValue('/root')
    expect(sourceFolder.className).toMatch(/font-mono/)
    expect(screen.getByText('root@192.168.1.10').parentElement?.className).toMatch(/font-mono/)
    expect(openSshSession).toHaveBeenCalled()
    expect(browseSshDirectory).toHaveBeenCalledWith(expect.any(String), '/root')
  })

  it('keeps the picker size when navigating into a smaller folder', async () => {
    vi.mocked(browseSshDirectory)
      .mockResolvedValueOnce({
        path: '/home',
        entries: [
          { name: '91295', path: '/home/91295', is_dir: true },
          { name: 'code', path: '/home/code', is_dir: true },
          { name: 'NEMPanelApp', path: '/home/NEMPanelApp', is_dir: true },
        ],
      })
      .mockResolvedValueOnce({
        path: '/home/code',
        entries: [{ name: 'ai-auto-test-dev', path: '/home/code/ai-auto-test-dev', is_dir: true }],
      })
    render(
      <>
        <SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />
        <ConfirmDialog />
      </>
    )
    await connectAndConfirm()
    const dialog = await screen.findByRole('dialog', { name: '选择远程项目' })
    const list = screen.getByRole('listbox', { name: '远程文件夹' })
    expect(dialog.className).toMatch(/w-\[min\(480px/)
    expect(dialog.className).toMatch(/h-\[min\(80vh,520px\)\]/)
    expect(list.className).toMatch(/flex-1/)

    fireEvent.doubleClick(await screen.findByRole('option', { name: 'code' }))
    expect(await screen.findByRole('option', { name: 'ai-auto-test-dev' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '选择远程项目' }).className).toMatch(/w-\[min\(480px/)
    expect(screen.getByRole('listbox', { name: '远程文件夹' }).className).toMatch(/flex-1/)
  })

  it('adds the selected remote folder as the project root', async () => {
    const addSshProject = vi.fn().mockResolvedValue(true)
    const onAdded = vi.fn()
    useProjectStore.setState({ addSshProject })
    render(
      <>
        <SshProjectDialog open onClose={vi.fn()} onAdded={onAdded} />
        <ConfirmDialog />
      </>
    )
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'wsl' } })
    await connectAndConfirm()

    fireEvent.click(await screen.findByRole('option', { name: '.claude' }))
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }))

    await waitFor(() => expect(addSshProject).toHaveBeenCalled())
    expect(addSshProject.mock.calls[0]?.[0]).toMatchObject({ name: 'wsl', host: '192.168.1.10' })
    expect(addSshProject.mock.calls[0]?.[1]).toBe('/root/.claude')
    expect(addSshProject.mock.calls[0]?.[2]).toBe('claude')
    expect(onAdded).toHaveBeenCalledOnce()
  })

  it('reuses a saved SSH connection to open another project without probing again', async () => {
    const addSshProject = vi.fn().mockResolvedValue(true)
    useProjectStore.setState({
      sshConnections: [
        {
          id: 'conn-1',
          name: 'WSL',
          host: 'localhost',
          port: 22,
          username: 'owner',
          auth_kind: 'privateKey',
          host_key_fingerprint: 'SHA256:saved',
          created_at: 1,
          updated_at: 1,
        },
      ],
      addSshProject,
    })
    render(<SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />)

    await waitFor(() => expect(screen.getByLabelText('SSH 连接')).toHaveValue('conn-1'))
    fireEvent.click(screen.getByRole('button', { name: '连接' }))

    expect(await screen.findByRole('dialog', { name: '选择远程项目' })).toBeInTheDocument()
    expect(probeSshHost).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('option', { name: 'go' }))
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }))

    await waitFor(() => expect(addSshProject).toHaveBeenCalled())
    expect(addSshProject.mock.calls[0]?.[0]).toMatchObject({ id: 'conn-1', host: 'localhost' })
    expect(addSshProject.mock.calls[0]?.[1]).toBe('/root/go')
  })

  it('does not disconnect a reused SSH session when the picker is cancelled', async () => {
    const onClose = vi.fn()
    useProjectStore.setState({
      sshConnections: [
        {
          id: 'conn-1',
          name: 'WSL',
          host: 'localhost',
          port: 22,
          username: 'owner',
          auth_kind: 'privateKey',
          host_key_fingerprint: 'SHA256:saved',
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
    render(<SshProjectDialog open onClose={onClose} onAdded={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('SSH 连接')).toHaveValue('conn-1'))
    fireEvent.click(screen.getByRole('button', { name: '连接' }))
    await screen.findByRole('dialog', { name: '选择远程项目' })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(disconnectSshSession).not.toHaveBeenCalled()
  })

  it('disconnects the browse session when the picker is cancelled', async () => {
    const onClose = vi.fn()
    render(
      <>
        <SshProjectDialog open onClose={onClose} onAdded={vi.fn()} />
        <ConfirmDialog />
      </>
    )
    await connectAndConfirm()
    await screen.findByRole('dialog', { name: '选择远程项目' })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledOnce()
    await waitFor(() => expect(disconnectSshSession).toHaveBeenCalled())
  })
})
