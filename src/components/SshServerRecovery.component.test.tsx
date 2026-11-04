// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshServerRecovery from './SshServerRecovery'
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), recover: vi.fn() }))
vi.mock('../lib/sshServerRecovery', () => ({ inspectServerPackage: mocks.inspect, recoverServerPackage: mocks.recover }))
const project = { id: 'remote', name: 'nem-panel', path: 'ssh://c/home/code/nem-panel', created_at: 1, last_opened_at: 1 }
const info = { expectedVersion: 'beta.9', packageVersion: 'beta.1', sourcePath: 'C:/QingCode/servers/server', problem: '版本不匹配' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.inspect.mockResolvedValue(info)
  mocks.recover.mockReset().mockResolvedValue(true)
})
describe('service recovery controls', () => {
  it('shows both versions and source, and retries after a valid selection', async () => {
    const retry = vi.fn()
    render(<SshServerRecovery project={project} opening={new AbortController()} onRetry={retry} onBusyChange={vi.fn()} />)
    expect(await screen.findByText('beta.9')).toBeInTheDocument()
    expect(screen.getByText('beta.1')).toBeInTheDocument()
    expect(screen.getByText(info.sourcePath)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新选择服务目录' })) })
    expect(retry).toHaveBeenCalledExactlyOnceWith()
  })
  it('keeps the controls usable after an invalid package and does not retry', async () => {
    const retry = vi.fn()
    mocks.recover.mockRejectedValue(new Error('SHA-256 不匹配'))
    render(<SshServerRecovery project={project} opening={new AbortController()} onRetry={retry} onBusyChange={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新选择服务目录' })) })
    expect(await screen.findByRole('alert')).toHaveTextContent('SHA-256 不匹配')
    expect(screen.getByRole('button', { name: '在线下载并重试' })).toBeEnabled()
    expect(retry).not.toHaveBeenCalled()
  })
  it('blocks duplicate downloads and ignores completion after the dialog closes', async () => {
    let finish!: (ok: boolean) => void
    const retry = vi.fn()
    mocks.recover.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<SshServerRecovery project={project} opening={new AbortController()} onRetry={retry} onBusyChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('beta.9')).toBeInTheDocument())
    const button = screen.getByRole('button', { name: '在线下载并重试' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.recover).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    const signal = mocks.recover.mock.calls[0][2] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { finish(true) })
    expect(retry).not.toHaveBeenCalled()
  })

  it('does not overwrite a selected package with a late initial inspection', async () => {
    let finishInspection!: (value: typeof info) => void
    mocks.inspect.mockImplementationOnce(() => new Promise(resolve => { finishInspection = resolve }))
    mocks.recover.mockImplementation(async (_project, _action, _signal, onInfo) => {
      onInfo({ ...info, sourcePath: 'C:/selected/servers/server' })
      throw new Error('selected package is obsolete')
    })
    render(<SshServerRecovery project={project} opening={new AbortController()} onRetry={vi.fn()} onBusyChange={vi.fn()} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新选择服务目录' })) })
    await act(async () => { finishInspection(info) })
    expect(screen.getByText('C:/selected/servers/server')).toBeInTheDocument()
    expect(screen.queryByText(info.sourcePath)).not.toBeInTheDocument()
  })
})
