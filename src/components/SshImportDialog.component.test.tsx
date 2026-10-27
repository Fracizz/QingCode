// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshImportDialog from './SshImportDialog'
import { useProjectStore } from '../store/projectStore'
import { safeInvoke } from '../lib/tauri'
import { connectionFromImport, type SshImportCandidate } from '../lib/sshConfigImport'

vi.mock('../lib/tauri', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  safeInvoke: vi.fn(),
}))

const candidate = (name: string, host = `${name}.test`): SshImportCandidate => ({
  name,
  host,
  port: 22,
  username: 'dev',
  authKind: 'privateKey',
  privateKeyPath: '/home/dev/.ssh/key',
  issue: null,
})
const save = vi.fn()
const close = vi.fn()
const imported = vi.fn()

describe('SSH config import selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(safeInvoke).mockResolvedValue({
      path: '/home/dev/.ssh/config',
      candidates: [candidate('one'), candidate('two')],
    })
    save.mockResolvedValue(undefined)
    useProjectStore.setState({ sshConnections: [], saveSshConnection: save, pushToast: vi.fn() })
  })

  it('saves only explicitly selected entries after confirmation, without inheriting trust', async () => {
    render(<SshImportDialog onClose={close} onImported={imported} />)
    expect(screen.getByRole('button', { name: '确认导入' })).toBeDisabled()
    fireEvent.click(await screen.findByRole('checkbox', { name: 'two' }))
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'two',
        host: 'two.test',
        private_key_path: '/home/dev/.ssh/key',
        host_key_fingerprint: '',
        mode: 'server',
      })
    )
    expect(imported).toHaveBeenCalledWith(expect.any(String))
    expect(safeInvoke).toHaveBeenCalledTimes(1)
  })

  it('disables existing endpoints and unsupported entries, filtering before select all', async () => {
    useProjectStore.setState({
      sshConnections: [connectionFromImport(candidate('saved', 'ONE.test'))],
    })
    vi.mocked(safeInvoke).mockResolvedValue({
      path: 'config',
      candidates: [
        candidate('one'),
        candidate('two'),
        { ...candidate('proxy'), issue: 'unsupported proxy' },
      ],
    })
    render(<SshImportDialog onClose={close} onImported={imported} />)
    expect(await screen.findByRole('checkbox', { name: 'one' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'proxy' })).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索连接' }), {
      target: { value: 'two' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }))
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'two' }))
  })

  it('keeps successful writes after a partial failure and retries only remaining targets', async () => {
    save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    render(<SshImportDialog onClose={close} onImported={imported} />)
    await screen.findByRole('checkbox', { name: 'one' })
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }))
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox', { name: 'one' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(save.mock.calls.map(([connection]) => connection.name)).toEqual(['one', 'two', 'two'])
  })

  it('deduplicates selected aliases for the same target and cancels without writes', async () => {
    vi.mocked(safeInvoke).mockResolvedValue({
      path: 'config',
      candidates: [candidate('one'), candidate('alias', 'one.test')],
    })
    const view = render(<SshImportDialog onClose={close} onImported={imported} />)
    await screen.findByRole('checkbox', { name: 'one' })
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(save).not.toHaveBeenCalled()
    view.unmount()
    close.mockClear()
    render(<SshImportDialog onClose={close} onImported={imported} />)
    await screen.findByRole('checkbox', { name: 'one' })
    fireEvent.click(screen.getByRole('checkbox', { name: '全选当前结果' }))
    fireEvent.click(screen.getByRole('button', { name: '确认导入' }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledOnce()
  })

  it('allows reload after a read failure', async () => {
    vi.mocked(safeInvoke).mockRejectedValueOnce(new Error('permission denied'))
    render(<SshImportDialog onClose={close} onImported={imported} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(await screen.findByRole('checkbox', { name: 'one' })).not.toBeDisabled()
  })
})
