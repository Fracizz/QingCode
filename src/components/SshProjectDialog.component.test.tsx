// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'
import SshProjectDialog from './SshProjectDialog'
import { INTERRUPT_MODAL_Z } from './ModalOverlay'
import { useConfirmStore } from '../store/confirmStore'
import { useProjectStore } from '../store/projectStore'
import { probeSshHost } from '../lib/sshWorkspace'

vi.mock('../lib/sshWorkspace', () => ({
  probeSshHost: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}))

const initialProjectState = useProjectStore.getState()

function fillSshForm() {
  fireEvent.change(screen.getByLabelText('主机'), { target: { value: '192.168.1.10' } })
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'root' } })
  fireEvent.change(screen.getByLabelText('私钥文件'), {
    target: { value: 'C:\\Users\\owner\\.ssh\\id_rsa2048' },
  })
  fireEvent.change(screen.getByLabelText('远程项目路径'), {
    target: { value: '/home/user/project' },
  })
}

describe('SshProjectDialog', () => {
  beforeEach(() => {
    vi.mocked(probeSshHost).mockReset()
    vi.mocked(probeSshHost).mockResolvedValue('SHA256:test-fingerprint')
    useProjectStore.setState({
      addSshProject: vi.fn().mockResolvedValue(true),
    })
  })

  afterEach(() => {
    useConfirmStore.getState().answer(false)
    useProjectStore.setState(initialProjectState, true)
  })

  it('shows the host-fingerprint confirm above the SSH form', async () => {
    render(
      <>
        <SshProjectDialog open onClose={vi.fn()} onAdded={vi.fn()} />
        <ConfirmDialog />
      </>
    )
    fillSshForm()
    fireEvent.click(screen.getByRole('button', { name: '连接并打开' }))

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
    fireEvent.click(screen.getByRole('button', { name: '连接并打开' }))

    await waitFor(() => expect(probeSshHost).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledOnce()

    resolveProbe('SHA256:late')
    await waitFor(() => expect(useConfirmStore.getState().request).toBeNull())
  })
})
