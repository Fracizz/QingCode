// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SshServerStatusChip from './SshServerStatusChip'
import { useProjectStore } from '../store/projectStore'

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<(event: { payload: unknown }) => void>,
}))

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
  mode: 'agent',
  version: '0.1.13',
  transport: 'daemon',
  reason: null,
}

describe('SshServerStatusChip', () => {
  const pushToast = vi.fn()

  beforeEach(() => {
    listeners.splice(0, listeners.length)
    invoke.mockReset()
    pushToast.mockReset()
    useProjectStore.setState({ pushToast })
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') return ready
      if (command === 'ssh_server_restart') return { ...ready, version: '0.2.0' }
      if (command === 'ssh_server_logs') return { text: 'daemon up' }
      throw new Error(`unexpected ${command}`)
    })
  })

  it('shows a concise chip whose aria-label carries the version, and ignores another project event', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    expect(await screen.findByRole('button', { name: 'Server v0.1.13 点击查看详情' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Server v0.1.13 点击查看详情' }).textContent).toBe('Server')
    listeners[0]?.({ payload: { ...ready, rootUri: 'ssh://other/path', version: '9.9.9' } })
    expect(screen.getByRole('button', { name: 'Server v0.1.13 点击查看详情' })).toBeTruthy()
    listeners[0]?.({ payload: { ...ready, version: '0.2.0' } })
    expect(await screen.findByRole('button', { name: 'Server v0.2.0 点击查看详情' })).toBeTruthy()
  })

  it('opens the details dialog on click and restarts from the right-click menu', async () => {
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', { name: 'Server v0.1.13 点击查看详情' })
    // 左键直接打开详情弹窗（头部带重启与日志入口）。
    fireEvent.click(chip)
    expect(await screen.findByText('Server 详情')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    // 右键菜单保留完整操作。
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Server v0.1.13 点击查看详情' }))
    fireEvent.click(screen.getByText('重启 Server'))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('重启 SSH Agent', 'ssh_server_restart', { rootUri })
    })
    expect(await screen.findByRole('button', { name: 'Server v0.2.0 点击查看详情' })).toBeTruthy()
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('success', '已重启远端服务')
    })
  })

  it('shows an error chip instead of faking direct mode when info fails', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'ssh_server_info') throw new Error('connection lost')
      throw new Error(`unexpected ${command}`)
    })
    render(<SshServerStatusChip rootUri={rootUri} />)
    const chip = await screen.findByRole('button', { name: 'Server 状态未知' })
    expect(chip.textContent).toBe('!')
    expect(screen.queryByText('直连')).toBeNull()
    // A later state event clears the error and restores the normal chip.
    listeners[0]?.({ payload: ready })
    expect(await screen.findByRole('button', { name: 'Server v0.1.13 点击查看详情' })).toBeTruthy()
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
    // 详情弹窗头部的日志入口进入日志视图。
    fireEvent.click(await screen.findByRole('button', { name: 'Server v0.1.13 点击查看详情' }))
    fireEvent.click(screen.getByRole('button', { name: '查看 Server 日志' }))
    expect(await screen.findByText('读取日志中…')).toBeTruthy()
    resolveLogs({ text: 'daemon up' })
    expect(await screen.findByText('daemon up')).toBeTruthy()
    // The refresh button re-fetches and shows the loading state again.
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText('读取日志中…')).toBeTruthy()
    resolveLogs({ text: 'daemon up again' })
    expect(await screen.findByText('daemon up again')).toBeTruthy()
  })
})
