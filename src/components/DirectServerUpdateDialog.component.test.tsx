// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DirectServerUpdateDialog from './DirectServerUpdateDialog'
import type { DirectServerUpdateApi } from '../lib/directServerUpdate'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import type { SshConnection } from '../types'

const rootUri = 'ssh://direct/project'
const ssh: SshConnection = {
  id: 'ssh',
  name: 'WinDev',
  host: 'host',
  port: 22,
  username: 'user',
  auth_kind: 'password',
  host_key_fingerprint: 'SHA256:fixture',
  created_at: 1,
  updated_at: 1,
}
const info = {
  expectedVersion: 'beta.14',
  packageVersion: 'beta.14',
  sourcePath: '/selected/servers/server',
  directory: '/selected/servers',
  problem: null,
}
const ready = {
  rootUri,
  connectionId: 'direct',
  phase: 'readyServer',
  mode: 'server',
  connectionMode: 'server',
  transport: 'agent',
  version: 'beta.14',
  reason: null,
}
let api: DirectServerUpdateApi
const pushToast = vi.fn()
const button = (name: string) => screen.getByRole('button', { name })
const prepare = async () => {
  fireEvent.click(button('检查并准备服务包'))
  await waitFor(() => expect(button('更新并重新连接')).toBeEnabled())
}
const automaticPreparation = async () => {
  await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(button('检查并准备服务包')).toBeEnabled())
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  api = {
    chooseDirectory: vi.fn().mockResolvedValue(info.directory),
    prepare: vi.fn().mockResolvedValue(info),
    update: vi.fn().mockResolvedValue(ready),
  }
  useProjectStore.setState({
    sshConnections: [ssh, { ...ssh, id: 'direct', agentEndpoint: { host: 'host', port: 48763 } }],
    pushToast,
  })
  useUIStore.setState({ serverUpdateRootUri: rootUri })
})

describe('direct Server package selection', () => {
  it('automatically prepares once in StrictMode, displays the package, and waits for an explicit update', async () => {
    const view = render(<StrictMode><DirectServerUpdateDialog rootUri={rootUri} api={api} /></StrictMode>)
    expect(screen.getByLabelText('服务包来源')).toHaveValue('automatic')
    expect(button('更新并重新连接')).toBeDisabled()
    expect(api.prepare).not.toHaveBeenCalled()
    await automaticPreparation()
    view.rerender(<StrictMode><DirectServerUpdateDialog rootUri={rootUri} api={api} /></StrictMode>)
    expect(api.prepare).toHaveBeenCalledTimes(1)
    expect(api.update).not.toHaveBeenCalled()
    expect(api.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ packageSource: { mode: 'automatic' } }),
      expect.any(Function)
    )
    expect(screen.getByText(info.sourcePath)).toBeVisible()
    fireEvent.click(button('更新并重新连接'))
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        expect.objectContaining({ packageDirectory: info.directory }),
        expect.any(Function)
      )
    )
    expect(useUIStore.getState().serverUpdateRootUri).toBeNull()
    expect(pushToast).toHaveBeenCalledWith('success', expect.any(String))
  })

  it('requires an offline directory and keeps an invalid package from enabling update', async () => {
    vi.mocked(api.prepare).mockResolvedValue({
      ...info,
      packageVersion: 'old',
      problem: '版本不匹配',
    })
    render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await automaticPreparation()
    fireEvent.change(screen.getByLabelText('服务包来源'), { target: { value: 'offline' } })
    expect(button('检查并准备服务包')).toBeDisabled()
    expect(screen.getByText(/本次更新不联网下载/)).toBeVisible()
    fireEvent.click(button('选择离线目录'))
    await waitFor(() => expect(button('检查并准备服务包')).toBeEnabled())
    fireEvent.click(button('检查并准备服务包'))
    expect(await screen.findByRole('alert')).toHaveTextContent('版本不匹配')
    expect(screen.getByText('old')).toBeVisible()
    expect(api.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ packageSource: { mode: 'offline', directory: info.directory } }),
      expect.any(Function)
    )
    expect(button('更新并重新连接')).toBeDisabled()
    expect(api.update).not.toHaveBeenCalled()
  })

  it('preserves a valid selection when the native picker is cancelled and invalidates it on mode or credentials changes', async () => {
    render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await automaticPreparation()
    fireEvent.change(screen.getByLabelText('服务包来源'), { target: { value: 'offline' } })
    fireEvent.click(button('选择离线目录'))
    await waitFor(() => expect(button('检查并准备服务包')).toBeEnabled())
    await prepare()
    vi.mocked(api.chooseDirectory).mockResolvedValue(null)
    fireEvent.click(button('选择离线目录'))
    await waitFor(() => expect(button('更新并重新连接')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('SSH 密码'), { target: { value: 'secret' } })
    expect(button('更新并重新连接')).toBeDisabled()
    await prepare()
    fireEvent.change(screen.getByLabelText('服务包来源'), { target: { value: 'automatic' } })
    expect(button('更新并重新连接')).toBeDisabled()
  })

  it('shows backend phases, blocks duplicate actions and dismiss, and requires revalidation after failure', async () => {
    let finish!: () => void
    vi.mocked(api.update).mockImplementation(async (_target, onProgress) => {
      onProgress('uploading')
      await new Promise<void>(resolve => {
        finish = resolve
      })
      onProgress('restoring')
      throw new Error('restart failed')
    })
    render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await automaticPreparation()
    fireEvent.click(button('更新并重新连接'))
    fireEvent.click(button('正在更新…'))
    expect(screen.getByRole('status')).toHaveTextContent('正在通过 SSH 上传并校验服务包…')
    expect(button('取消')).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useUIStore.getState().serverUpdateRootUri).toBe(rootUri)
    expect(api.update).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('restart failed')
    expect(button('更新并重新连接')).toBeDisabled()
    expect(button('检查并准备服务包')).toBeEnabled()
  })

  it('ignores late preparation results and progress after changing projects', async () => {
    const finish: Array<(value: typeof info) => void> = []
    vi.mocked(api.prepare).mockImplementation(
      () =>
        new Promise(resolve => {
          finish.push(resolve)
        })
    )
    const view = render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1))
    const onProgress = vi.mocked(api.prepare).mock.calls[0][1]
    view.rerender(<DirectServerUpdateDialog rootUri="ssh://direct/other-project" api={api} />)
    await act(async () => {
      onProgress('downloading')
      finish[0](info)
    })
    expect(screen.queryByText(info.sourcePath)).toBeNull()
    expect(button('更新并重新连接')).toBeDisabled()
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(2))
    await act(async () => { finish[1](info) })
    expect(button('更新并重新连接')).toBeEnabled()
  })

  it('does not loop after automatic preparation fails and allows a manual retry', async () => {
    vi.mocked(api.prepare).mockRejectedValueOnce(new Error('SSH authentication failed'))
    const view = render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await automaticPreparation()
    expect(screen.getByRole('alert')).toHaveTextContent('SSH authentication failed')
    view.rerender(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    fireEvent.change(screen.getByLabelText('SSH 密码'), { target: { value: 'secret' } })
    await act(async () => {})
    expect(api.prepare).toHaveBeenCalledTimes(1)
    expect(button('更新并重新连接')).toBeDisabled()
    await prepare()
    expect(api.prepare).toHaveBeenCalledTimes(2)
  })

  it('prepares again when the dialog is reopened', async () => {
    const view = render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await automaticPreparation()
    view.unmount()
    render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(button('更新并重新连接')).toBeEnabled())
    expect(api.update).not.toHaveBeenCalled()
  })

  it('waits for an eligible SSH connection before automatically preparing', async () => {
    useProjectStore.setState({ sshConnections: [] })
    render(<DirectServerUpdateDialog rootUri={rootUri} api={api} />)
    await act(async () => {})
    expect(api.prepare).not.toHaveBeenCalled()
    act(() => useProjectStore.setState({ sshConnections: [ssh, { ...ssh, id: 'direct', agentEndpoint: { host: 'host', port: 48763 } }] }))
    await automaticPreparation()
    expect(button('更新并重新连接')).toBeEnabled()
  })
})
