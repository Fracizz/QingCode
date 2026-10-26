// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshServerStatusChip from './SshServerStatusChip'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'

const { invoke, listeners, switchSshConnectionMode, confirmDialog } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<(event: { payload: unknown }) => void>,
  switchSshConnectionMode: vi.fn(),
  confirmDialog: vi.fn(),
}))

vi.mock('../lib/sshWorkspace', () => ({
  switchSshConnectionMode,
  sshConnectionLabel: () => 'WSL（root@localhost）',
  sshRemotePathFromUri: (path: string) => path.replace(/^ssh:\/\/[^/]+/, '') || '/',
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog }))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => invoke(...args),
  NotInTauriError: class NotInTauriError extends Error {
    constructor(action: string) {
      super(action)
      this.name = 'NotInTauriError'
    }
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.push(callback)
    return () => {
      const index = listeners.indexOf(callback)
      if (index >= 0) listeners.splice(index, 1)
    }
  }),
}))

const rootUri = 'ssh://c1/home/app'

const ready = {
  connectionId: 'c1',
  rootUri,
  phase: 'readyServer',
  mode: 'server',
  connectionMode: 'server',
  version: '0.1.13',
  transport: 'daemon',
  reason: null,
}

const probing = {
  ...ready,
  phase: 'probing',
  mode: 'unknown',
  version: null,
  transport: null,
}

const serverChipName = (version = '0.1.13') =>
  `SSH + 远端服务 运行方式：常驻服务 远端服务 v${version} 点击查看详情`

describe('SshServerStatusChip', () => {
  const pushToast = vi.fn()
  const requestSettings = vi.fn()

  beforeEach(() => {
    listeners.splice(0, listeners.length)
    invoke.mockReset()
    pushToast.mockReset()
    requestSettings.mockReset()
    switchSshConnectionMode.mockReset().mockResolvedValue(undefined)
    confirmDialog.mockReset().mockResolvedValue(true)
    useProjectStore.setState({ pushToast, sshConnections: [] })
    useUIStore.setState({ requestSettings })
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return ready
      if (command === 'ssh_server_restart') return { ...ready, version: '0.2.0' }
      if (command === 'ssh_server_logs') return { text: 'daemon up' }
      throw new Error(`unexpected ${command}`)
    })
  })

  it('shows a concise chip whose aria-label carries the version, and ignores another project event', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
    expect(screen.getByRole('button', { name: serverChipName() }).textContent).toBe('SSH + 服务')
    listeners[0]?.({ payload: { ...ready, rootUri: 'ssh://other/path', version: '9.9.9' } })
    expect(screen.getByRole('button', { name: serverChipName() })).toBeTruthy()
    listeners[0]?.({ payload: { ...ready, version: '0.2.0' } })
    expect(await screen.findByRole('button', { name: serverChipName('0.2.0') })).toBeTruthy()
  })

  it('subscribes before reading status and refreshes a pending snapshot', async () => {
    let infoCalls = 0
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command !== 'ssh_server_info') throw new Error(`unexpected ${command}`)
      // The first snapshot must be requested only after the event listener exists.
      expect(listeners).toHaveLength(1)
      infoCalls += 1
      return infoCalls === 1
        ? { ...ready, phase: 'probing', mode: 'unknown', version: null, transport: null }
        : ready
    })

    render(<SshServerStatusChip rootUri={rootUri} />)
    expect(await screen.findByRole('button', { name: /正在探测/ })).toBeTruthy()
    expect(
      await screen.findByRole(
        'button',
        { name: serverChipName() },
        { timeout: 3000 },
      )
    ).toBeTruthy()
    expect(infoCalls).toBe(2)
  })

  it('opens the details dialog on click and restarts from the right-click menu', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', { name: serverChipName() })
    // 左键打开连接概览，右键保留快捷操作。
    fireEvent.click(chip)
    expect(await screen.findByRole('dialog', { name: '远程连接' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }))
    // 右键菜单保留完整操作。
    fireEvent.contextMenu(screen.getByRole('button', { name: serverChipName() }))
    fireEvent.click(screen.getByText('重启远端服务'))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('重启 SSH Agent', 'ssh_server_restart', { rootUri })
    })
    expect(await screen.findByRole('button', { name: serverChipName('0.2.0') })).toBeTruthy()
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('success', '已重启远端服务')
    })
  })

  it('keeps Server actions focused on restart and logs without offering direct mode', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', { name: serverChipName() })
    fireEvent.contextMenu(chip)
    expect(screen.queryByText('切到 SSH 模式')).toBeNull()
    expect(screen.getByText('重启远端服务')).toBeTruthy()
    expect(screen.getByText('查看远端服务日志')).toBeTruthy()
    expect(switchSshConnectionMode).not.toHaveBeenCalled()
    expect(confirmDialog).not.toHaveBeenCalled()

    // 详情同样只提供服务恢复操作。
    fireEvent.click(screen.getByRole('button', { name: serverChipName() }))
    expect(await screen.findByRole('dialog', { name: '远程连接' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '切到 SSH 模式' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '重启远端服务' })).toHaveLength(1)
  })

  it('cancels a service restart without calling the backend', async () => {
    confirmDialog.mockResolvedValue(false)
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.contextMenu(await screen.findByRole('button', { name: serverChipName() }))
    fireEvent.click(screen.getByText('重启远端服务'))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith({
      title: '重启远端服务',
      message: '重启会结束此远端服务托管的终端，可能影响同一远端用户下的其他项目。',
      kind: 'warning', confirmLabel: '重启', cancelLabel: '取消',
    }))
    expect(invoke).not.toHaveBeenCalledWith('重启 SSH Agent', 'ssh_server_restart', { rootUri })
  })

  it('opens installation settings from Server details and closes the dialog', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    fireEvent.click(screen.getByRole('button', { name: '服务安装设置' }))
    expect(requestSettings).toHaveBeenCalledWith('ssh.server')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not offer switching to SSH mode while already direct', async () => {
    const direct = {
      ...ready,
      phase: 'readyDirect',
      mode: 'direct',
      version: null,
      transport: 'direct',
      reason: null,
    }
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return direct
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', { name: 'SSH 直连 点击查看详情' })
    fireEvent.contextMenu(chip)
    expect(screen.queryByText('切到 SSH 模式')).toBeNull()
    fireEvent.click(chip)
    expect(await screen.findByRole('dialog', { name: '远程连接' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '切到 SSH 模式' })).toBeNull()
  })

  it('shows SSH for a connection configured in SSH mode and switches back to Server', async () => {
    const sshMode = {
      ...ready,
      phase: 'readyDirect',
      mode: 'direct',
      connectionMode: 'ssh',
      version: null,
      transport: 'direct',
      reason: 'SSH 模式（连接配置）',
    }
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return sshMode
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', {
      name: 'SSH 兼容模式 已启用兼容模式，不部署远端服务 点击查看详情',
    })
    expect(chip.textContent).toBe('SSH 兼容模式')
    fireEvent.contextMenu(chip)
    // SSH 模式没有远端服务：隐藏重启与日志，只提供切回 Server。
    expect(screen.queryByText('重启远端服务')).toBeNull()
    expect(screen.queryByText('查看远端服务日志')).toBeNull()
    fireEvent.click(screen.getByText('切换到 Server 模式'))
    await waitFor(() => expect(switchSshConnectionMode).toHaveBeenCalledWith('c1', 'server'))
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    expect(pushToast).toHaveBeenCalledWith('success', '已切换到 Server 模式')
  })

  it('shows an error chip instead of faking direct mode when info fails', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') throw new Error('connection lost')
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', { name: '远端服务状态未知' })
    expect(chip.textContent).toBe('!')
    expect(screen.queryByText('SSH 直连')).toBeNull()
    // A later state event clears the error and restores the normal chip.
    listeners[0]?.({ payload: ready })
    expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
  })

  it('retries a failed status query when the error chip is clicked', async () => {
    invoke.mockRejectedValueOnce(new Error('connection lost'))
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: '远端服务状态未知' }))
    expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
    expect(switchSshConnectionMode).not.toHaveBeenCalled()
  })

  it('retries an unavailable Server without offering compatibility mode', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') {
        return { ...ready, phase: 'readyDirect', mode: 'direct', reason: 'server 启动超时' }
      }
      if (command === 'ssh_server_restart') return ready
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.contextMenu(await screen.findByRole('button', { name: /server 启动超时/ }))
    expect(screen.queryByText('切到 SSH 模式')).toBeNull()
    fireEvent.click(screen.getByText('重启远端服务'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('重启 SSH Agent', 'ssh_server_restart', { rootUri }))
    expect(switchSshConnectionMode).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
  })

  it('keeps Server retries disabled until the workspace is trusted', async () => {
    invoke.mockResolvedValue({ ...ready, phase: 'readyDirect', mode: 'direct', reason: '工作区未信任' })
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: /工作区未信任/ }))
    expect(screen.getByText('请先信任该工作区，再切换到远端服务')).toBeTruthy()
    for (const retry of screen.getAllByRole('button', { name: '重试远端服务' })) {
      expect((retry as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(retry)
    }
    expect(invoke).not.toHaveBeenCalledWith('重启 SSH Agent', 'ssh_server_restart', { rootUri })
  })

  it('subscribes to state events before reading the snapshot', async () => {
    let listenersAtQuery = -1
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') {
        listenersAtQuery = listeners.length
        return ready
      }
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    await screen.findByRole('button', { name: serverChipName() })
    expect(listenersAtQuery).toBe(1)
  })

  it('recovers from a probing snapshot by polling and stops once ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let calls = 0
      invoke.mockImplementation(async (_action: string, command: string) => {
        if (command !== 'ssh_server_info') throw new Error(`unexpected ${command}`)
        calls += 1
        if (calls === 1) return probing
        if (calls === 2) return { ...probing, phase: 'handshaking' }
        return ready
      })
      render(<SshServerStatusChip rootUri={rootUri} />)
      expect(await screen.findByText('SSH 服务…')).toBeTruthy()
      await act(() => vi.advanceTimersByTimeAsync(1600))
      await act(() => vi.advanceTimersByTimeAsync(1600))
      expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
      const settled = calls
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(calls).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a snapshot that was requested before a newer state event', async () => {
    let resolveInfo: (value: unknown) => void = () => {}
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') {
        return await new Promise(resolve => {
          resolveInfo = resolve
        })
      }
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    act(() => listeners[0]?.({ payload: ready }))
    expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
    // 晚到的旧快照不能把已就绪覆盖回「正在探测」。
    await act(async () => resolveInfo(probing))
    expect(screen.getByRole('button', { name: serverChipName() })).toBeTruthy()
    expect(screen.queryByText('SSH 服务…')).toBeNull()
  })

  it('shows stage timings in the details dialog', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return { ...ready, timings: '发现 1.2s · 合计 1.5s' }
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    expect(await screen.findByText('就绪用时 1.5s')).toBeTruthy()
    fireEvent.click(screen.getByText('就绪用时 1.5s'))
    expect(screen.getByRole('list', { name: '分阶段耗时' }).textContent).toContain('发现1.2s')
  })

  it('falls back to raw timing text when the summary format is unknown', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return { ...ready, timings: '未知格式' }
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    expect(await screen.findByText('未知格式')).toBeTruthy()
  })

  it('shows a disconnected chip with the reason and recovers on the next state event', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') {
        return { ...probing, phase: 'disconnected', reason: '保活超时：约 40 秒未收到远端任何回包' }
      }
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    expect(await screen.findByText('SSH 已断开')).toBeTruthy()
    act(() => listeners[0]?.({ payload: ready }))
    expect(await screen.findByRole('button', { name: serverChipName() })).toBeTruthy()
  })

  it('hides the chip when the command is missing', async () => {
    invoke.mockRejectedValue(Object.assign(new Error('command ssh_server_info not found'), { name: 'Error' }))
    render(<SshServerStatusChip rootUri={rootUri} />)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a loading state and refreshes the log dialog', async () => {
    let resolveLogs: (value: { text: string }) => void = () => {}
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return ready
      if (command === 'ssh_server_logs') {
        return await new Promise<{ text: string }>(resolve => {
          resolveLogs = resolve
        })
      }
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    // 在同一弹窗内切换到日志视图。
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    fireEvent.click(screen.getByRole('tab', { name: '服务日志' }))
    expect(await screen.findByText('读取日志中…')).toBeTruthy()
    resolveLogs({ text: 'daemon up' })
    expect(await screen.findByText('daemon up')).toBeTruthy()
    // The refresh button re-fetches and shows the loading state again.
    fireEvent.click(screen.getByRole('button', { name: '刷新日志' }))
    expect(await screen.findByText('读取日志中…')).toBeTruthy()
    resolveLogs({ text: 'daemon up again' })
    expect(await screen.findByText('daemon up again')).toBeTruthy()
  })

  it('keeps logs while refreshing and lets the user return to the overview with the keyboard', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    expect(screen.getByText('/home/app')).toBeTruthy()
    expect(screen.getByText('远端服务已就绪')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭对话框' }))
    const overview = screen.getByRole('tab', { name: '概览' })
    fireEvent.keyDown(overview, { key: 'ArrowRight' })
    expect(await screen.findByText('daemon up')).toBeTruthy()
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_logs') return new Promise(() => {})
      throw new Error(`unexpected ${command}`)
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新日志' }))
    expect(screen.getByText('daemon up')).toBeTruthy()
    expect((screen.getByRole('button', { name: '刷新日志' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('tab', { name: '服务日志' }), { key: 'ArrowLeft' })
    expect(screen.getByText('远端服务已就绪')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true')
  })

  it('shows a log error inline and recovers through refresh', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    invoke.mockRejectedValueOnce(new Error('permission denied'))
    fireEvent.click(screen.getByRole('tab', { name: '服务日志' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    expect(screen.queryByText('暂无日志。服务启动后可刷新查看。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新日志' }))
    expect(await screen.findByText('daemon up')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not offer duplicate deployment while the service is being prepared', async () => {
    invoke.mockResolvedValue(probing)
    render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: /正在探测/ }))
    expect(screen.getByText('正在检查远端服务')).toBeTruthy()
    const retry = screen.getByRole('button', { name: '重试远端服务' }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    fireEvent.click(retry)
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  it('ignores log responses from the previous project', async () => {
    let resolveOldLogs: (value: { text: string }) => void = () => {}
    const newRoot = 'ssh://c1/home/another'
    invoke.mockImplementation(async (_action: string, command: string, args: { rootUri: string }) => {
      if (command === 'ssh_server_info') return { ...ready, rootUri: args.rootUri }
      if (command === 'ssh_server_logs') {
        if (args.rootUri === newRoot) return { text: 'new project logs' }
        return new Promise(resolve => { resolveOldLogs = resolve })
      }
      throw new Error(`unexpected ${command}`)
    })
    const { rerender } = render(<SshServerStatusChip rootUri={rootUri} />)
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    fireEvent.click(screen.getByRole('tab', { name: '服务日志' }))
    rerender(<SshServerStatusChip rootUri={newRoot} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: serverChipName() }))
    fireEvent.click(screen.getByRole('tab', { name: '服务日志' }))
    expect(await screen.findByText('new project logs')).toBeTruthy()
    await act(async () => resolveOldLogs({ text: 'old project logs' }))
    expect(screen.getByText('new project logs')).toBeTruthy()
    expect(screen.queryByText('old project logs')).toBeNull()
  })
})
