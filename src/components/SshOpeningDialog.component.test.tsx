// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import ServerOperationTasks from './ServerOperationTasks'
import { cancelSshOpening, runSshOpening, SshPreparationError, latestSshOpening } from '../store/sshOpeningStore'
import type { Project, SshConnection } from '../types'

const mocks = vi.hoisted(() => ({ switchProject: vi.fn(), confirm: vi.fn(), pushToast: vi.fn(), connections: [] as SshConnection[] }))
vi.mock('../store/projectStore', () => ({
  useProjectStore: Object.assign((selector: (state: unknown) => unknown) => selector({ sshConnections: mocks.connections }), {
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
  mocks.connections = []
  mocks.confirm.mockReset().mockResolvedValue(true)
})
afterEach(() => cancelSshOpening())

describe('SshOpeningDialog', () => {
  it('explains a cancelled Server connection and keeps raw diagnostics in a closed disclosure', async () => {
    const error = '[direct:unreachable] Server 连接已由当前连接配置关闭'
    await runSshOpening(project, async (_signal, report) => {
      report('service', { rootUri: project.path, connectionId: 'c', connectionMode: 'server', phase: 'handshaking', mode: 'server', transport: 'agent', reason: null, version: null })
      throw new SshPreparationError(error)
    }).catch(() => {})
    render(<ServerOperationTasks />)
    expect(screen.getByText('连接 Server')).toBeVisible()
    expect(screen.queryByText('连接 SSH')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Server 连接在本机被取消')
    expect(screen.getByRole('alert')).not.toHaveTextContent('[direct:unreachable]')
    expect(screen.getByText('准备远端服务和终端').closest('li')).toHaveAttribute('aria-current', 'step')
    const details = screen.getByText('技术详情').closest('details')!
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent(error)
    expect(screen.queryByRole('region', { name: '修复远端服务包' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.switchProject).toHaveBeenCalledWith(project)
  })

  it('uses saved Server metadata before a runtime state arrives and preserves identity guidance', async () => {
    mocks.connections = [{ id: 'c', name: 'WSL', host: 'localhost', port: 22, username: 'root', auth_kind: 'privateKey', host_key_fingerprint: 'SHA256:ssh', created_at: 1, agentEndpoint: { host: 'localhost', port: 48763 } }]
    await runSshOpening(project, async () => { throw new SshPreparationError('[direct:identity] certificate changed') }).catch(() => {})
    render(<ServerOperationTasks />)
    expect(screen.getByText('连接 Server')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Server 证书指纹不匹配')
    expect(screen.queryByRole('region', { name: '修复远端服务包' })).not.toBeInTheDocument()
  })

  it('retains SSH as the first step when the Server uses an SSH tunnel', async () => {
    await runSshOpening(project, async (_signal, report) => {
      report('service', { rootUri: project.path, connectionId: 'c', connectionMode: 'server', phase: 'handshaking', mode: 'server', transport: 'tunnel', reason: null, version: null })
      throw new SshPreparationError('[direct:timeout] timeout')
    }).catch(() => {})
    render(<ServerOperationTasks />)
    expect(screen.getByText('连接 SSH')).toBeVisible()
    expect(screen.queryByText('连接 Server')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('连接超时')
  })

  it('keeps the workspace usable when mounting a project on a ready shared daemon', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('mounting')
      report('service')
      return new Promise(() => {})
    }).catch(error => error)
    render(<ServerOperationTasks />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在打开项目 demo')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector('[data-modal-overlay]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect((await opening).name).toBe('AbortError')
  })
  it('stacks SSH connections and cancels only the chosen one', async () => {
    const first = runSshOpening(project, () => new Promise(() => {})).catch(error => error)
    const second = runSshOpening(windowsProject, () => new Promise(() => {})).catch(error => error)
    render(<ServerOperationTasks />)
    fireEvent.click(await screen.findByRole('button', { name: /远程任务 2/ }))
    expect(screen.getByRole('region', { name: 'Windows A' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /c demo/ }))
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect((await first).name).toBe('AbortError')
    expect(screen.queryByRole('region', { name: 'demo' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Windows A' })).toBeInTheDocument()
    expect(latestSshOpening()?.project).toEqual(windowsProject)
    cancelSshOpening()
    expect((await second).name).toBe('AbortError')
  })
  it('hides the progress card when run in background but keeps opening and re-shows on error', async () => {
    let fail!: (error: Error) => void
    const opening = runSshOpening(project, () => new Promise((_resolve, reject) => { fail = reject })).catch(error => error)
    render(<ServerOperationTasks />)
    await screen.findByRole('status')
    fireEvent.click(screen.getByRole('button', { name: '后台运行' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(latestSshOpening()?.background).toBe(true)
    expect(latestSshOpening()?.controller.signal.aborted).toBe(false)
    await act(async () => { fail(new SshPreparationError('boom')) })
    expect(await opening).toBeInstanceOf(SshPreparationError)
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })

  it('shows the terminal preparation stage and allows cancelling without activating a project', async () => {
    const opening = runSshOpening(project, async (_signal, report) => {
      report('service', { rootUri: project.path, connectionId: 'c', connectionMode: 'server', phase: 'readyServer', mode: 'server', transport: 'serve', reason: null, version: '1' })
      return new Promise(() => {})
    }).catch(error => error)
    render(<ServerOperationTasks />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在准备远程终端')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '第 4/4 步')
    fireEvent.click(screen.getByRole('button', { name: '取消打开' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await opening).name).toBe('AbortError')
    expect(mocks.switchProject).not.toHaveBeenCalled()
  })

  it('keeps readable failure details and retries the same project', async () => {
    await runSshOpening(project, async () => { throw new SshPreparationError('daemon failed\nnetwork detail') }).catch(() => {})
    render(<ServerOperationTasks />)
    expect(screen.getByRole('alert')).toHaveTextContent('daemon failed network detail')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.switchProject).toHaveBeenCalledWith(project)
  })

  it('does not reopen a project closed during Windows repair preflight', async () => {
    let finish!: (accepted: boolean) => void
    mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
    await failOpening()
    render(<ServerOperationTasks />)
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
    render(<ServerOperationTasks />)
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
    const view = render(<ServerOperationTasks />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    const signal = mocks.confirm.mock.calls[0][3] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { finish(true) })
    expect(mocks.switchProject).not.toHaveBeenCalled()
  })

  it('can retry a failed opening whose original timeout signal is already aborted', async () => {
    await failOpening()
    latestSshOpening()!.controller.abort(new SshPreparationError('timeout'))
    render(<ServerOperationTasks />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    expect(mocks.switchProject).toHaveBeenCalledExactlyOnceWith(windowsProject)
    expect((mocks.confirm.mock.calls[0][3] as AbortSignal).aborted).toBe(false)
  })
})
