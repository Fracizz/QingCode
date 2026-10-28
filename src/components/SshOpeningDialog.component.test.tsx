// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import SshOpeningDialog from './SshOpeningDialog'
import { cancelSshOpening, runSshOpening, SshPreparationError, useSshOpeningStore } from '../store/sshOpeningStore'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({ switchProject: vi.fn(), confirm: vi.fn(), pushToast: vi.fn() }))
vi.mock('../store/projectStore', () => ({
  useProjectStore: Object.assign((selector: (state: unknown) => unknown) => selector({ sshConnections: [] }), {
    getState: () => ({ switchProject: mocks.switchProject, pushToast: mocks.pushToast }),
  }),
}))
vi.mock('../lib/sshWindowsRepair', () => ({
  isWindowsSshRoot: (root: string) => /^ssh:\/\/[^/]+\/[A-Za-z]:\//.test(root),
  confirmSshServerRestart: (...args: unknown[]) => mocks.confirm(...args),
}))

const project: Project = { id: 'remote', name: 'demo', path: 'ssh://c/home/demo', kind: 'ssh', created_at: 1, last_opened_at: 1 }
const windowsProject: Project = { ...project, id: 'win-a', name: 'Windows A', path: 'ssh://win/D:/a' }
const otherWindowsProject: Project = { ...windowsProject, id: 'win-b', name: 'Windows B', path: 'ssh://win/D:/b' }

async function failOpening(target = windowsProject) {
  await runSshOpening(target, async () => { throw new SshPreparationError('SSH 连接超时：握手失败') }).catch(() => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.confirm.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  cancelSshOpening()
  vi.useRealTimers()
})

describe('SshOpeningDialog', () => {
  it('keeps elapsed time and cancellation when moving to the background and back', async () => {
    vi.useFakeTimers()
    const opening = runSshOpening(project, async (_signal, report) => {
      report('service')
      return new Promise(() => {})
    }).catch(error => error)
    render(<SshOpeningDialog />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2300) })
    expect(screen.getByRole('timer')).toHaveTextContent('已用时 2 秒')
    fireEvent.click(screen.getByRole('button', { name: '后台运行' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-modal-overlay]')).not.toBeInTheDocument()
    const attempt = useSshOpeningStore.getState().attempt!
    expect(attempt.controller.signal.aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('timer')).toHaveTextContent('已用时 5 秒')
    fireEvent.click(screen.getByRole('button', { name: '查看进度' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('timer')).toHaveTextContent('已用时 5 秒')
    expect(useSshOpeningStore.getState().attempt?.controller).toBe(attempt.controller)
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect((await opening).name).toBe('AbortError')
  })

  it('shows a background failure and freezes elapsed time at failure', async () => {
    vi.useFakeTimers()
    let fail!: (reason: Error) => void
    const opening = runSshOpening(project, async () => new Promise((_, reject) => { fail = reject })).catch(error => error)
    render(<SshOpeningDialog />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1300) })
    fireEvent.click(screen.getByRole('button', { name: '后台运行' }))
    await act(async () => { fail(new SshPreparationError('handshake failed')); await opening })
    expect(screen.getByRole('alert')).toHaveTextContent('handshake failed')
    expect(screen.getByRole('timer')).toHaveTextContent('已用时 1 秒')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByRole('timer')).toHaveTextContent('已用时 1 秒')
  })

  it('can expand the shared-daemon progress card', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('mounting')
      return new Promise(() => {})
    }).catch(error => error)
    render(<SshOpeningDialog />)
    fireEvent.click(await screen.findByRole('button', { name: '查看进度' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    await opening
  })

  it('keeps the workspace usable when mounting a project on a ready shared daemon', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('mounting')
      report('service')
      return new Promise(() => {})
    }).catch(error => error)
    render(<SshOpeningDialog />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在打开项目 demo')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-modal-overlay]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect((await opening).name).toBe('AbortError')
  })
  it('shows the terminal preparation stage and allows cancelling without activating a project', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('service', { rootUri: project.path, connectionId: 'c', connectionMode: 'server', phase: 'readyServer', mode: 'server', transport: 'serve', reason: null, version: '1' })
      return new Promise(() => {})
    }).catch(error => error)
    render(<SshOpeningDialog />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在准备远程终端')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await opening).name).toBe('AbortError')
    expect(mocks.switchProject).not.toHaveBeenCalled()
  })

  it('keeps readable failure details and retries the same project', async () => {
    await runSshOpening(project, async () => { throw new SshPreparationError('daemon failed\nnetwork detail') }).catch(() => {})
    render(<SshOpeningDialog />)
    expect(screen.getByRole('alert')).toHaveTextContent('daemon failed network detail')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.switchProject).toHaveBeenCalledWith(project)
  })

  it('does not reopen a project closed during Windows repair preflight', async () => {
    let finish!: (accepted: boolean) => void
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
    await failOpening()
    render(<SshOpeningDialog />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    const signal = mocks.confirm.mock.calls[0][3] as AbortSignal
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(signal.aborted).toBe(true)
    await act(async () => { finish(true) })
    expect(mocks.switchProject).not.toHaveBeenCalled()
  })

  it('allows a newer retry and ignores the old completion without unlocking the new retry', async () => {
    const finish: Array<(accepted: boolean) => void> = []
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finish.push(resolve) }))
    await failOpening()
    render(<SshOpeningDialog />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await act(async () => { await failOpening(otherWindowsProject) })
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await act(async () => { finish[0](true) })
    expect(mocks.switchProject).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
    await act(async () => { finish[1](true) })
    expect(mocks.switchProject).toHaveBeenCalledExactlyOnceWith(otherWindowsProject)
  })

  it('cancels the pending retry when the dialog component unmounts', async () => {
    let finish!: (accepted: boolean) => void
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
    await failOpening()
    const view = render(<SshOpeningDialog />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    const signal = mocks.confirm.mock.calls[0][3] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { finish(true) })
    expect(mocks.switchProject).not.toHaveBeenCalled()
  })

  it('can retry a failed opening whose original timeout signal is already aborted', async () => {
    await failOpening()
    useSshOpeningStore.getState().attempt!.controller.abort(new SshPreparationError('timeout'))
    render(<SshOpeningDialog />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    expect(mocks.switchProject).toHaveBeenCalledExactlyOnceWith(windowsProject)
    expect((mocks.confirm.mock.calls[0][3] as AbortSignal).aborted).toBe(false)
  })
})
