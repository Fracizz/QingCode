// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import DirectSshFallback from './DirectSshFallback'
import type { SshConnection } from '../types'

const { restore, confirm } = vi.hoisted(() => ({ restore: vi.fn(), confirm: vi.fn() }))
vi.mock('../lib/sshWorkspace', () => ({ restoreSshTransport: restore }))
vi.mock('../store/confirmStore', () => ({ confirmDialog: confirm }))
const connection: SshConnection = { id: 'c1', name: 'WSL', host: 'localhost', port: 2222, username: 'dev', auth_kind: 'password', host_key_fingerprint: 'SHA256:ssh', created_at: 1 }
const info = { enabled: true, host: 'localhost', port: 48763, certificateFingerprint: 'tls', tokenSaved: true, previousPorts: [] }
beforeEach(() => { vi.clearAllMocks(); confirm.mockResolvedValue(true); restore.mockResolvedValue({ ...info, enabled: false }) })

it('shows the actual SSH endpoint and switches to the selected mode before notifying its caller', async () => {
  const switched = vi.fn()
  render(<DirectSshFallback connection={connection} info={info} onSwitched={switched} />)
  expect(screen.getByText('dev@localhost:2222')).toBeVisible()
  fireEvent.change(screen.getByLabelText('SSH 连接方式'), { target: { value: 'ssh' } })
  fireEvent.click(screen.getByRole('button', { name: '切换到 SSH' }))
  await waitFor(() => expect(switched).toHaveBeenCalledWith({ ...info, enabled: false }))
  expect(restore).toHaveBeenCalledWith(connection, info, 'ssh')
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: 'dev@localhost:2222\nSSH 直连（兼容模式）' }))
})

it('does not change the transport when confirmation is cancelled', async () => {
  confirm.mockResolvedValue(false)
  render(<DirectSshFallback connection={connection} info={info} onSwitched={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '切换到 SSH' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '切换到 SSH' })).not.toBeDisabled())
  expect(restore).not.toHaveBeenCalled()
})

it('keeps switching errors visible without reporting success', async () => {
  restore.mockRejectedValueOnce(new Error('credential storage unavailable'))
  const switched = vi.fn()
  render(<DirectSshFallback connection={connection} info={info} onSwitched={switched} />)
  fireEvent.click(screen.getByRole('button', { name: '切换到 SSH' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('credential storage unavailable')
  expect(switched).not.toHaveBeenCalled()
})

it('offers SSH configuration for a Server-only record without using the placeholder as an SSH identity', () => {
  render(<DirectSshFallback connection={{ ...connection, username: 'Agent', host_key_fingerprint: 'tls' }} info={info} onSwitched={vi.fn()} />)
  expect(screen.getByRole('button', { name: '新建 SSH 连接' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '切换到 SSH' })).toBeNull()
})
