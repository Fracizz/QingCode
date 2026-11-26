// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RemoteSystemMetricsPanel from './RemoteSystemMetricsPanel'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => invoke(...args),
}))

const snapshot = (cpuUsage: number) => ({
  cpuThreads: 16, cpuCores: 8, cpuBaseMhz: 3000, cpuUsage, memoryTotal: 16 * 1024 ** 3, memoryUsed: 4 * 1024 ** 3,
})

describe('RemoteSystemMetricsPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    invoke.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('shows CPU and memory configuration with usage and polls at the chosen interval', async () => {
    invoke.mockResolvedValueOnce(snapshot(12.5)).mockResolvedValue(snapshot(80))
    render(<dl><RemoteSystemMetricsPanel rootUri="ssh://c1/home/app" /></dl>)
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith(expect.any(String), 'ssh_server_system_metrics', { rootUri: 'ssh://c1/home/app' })
    expect(screen.getByText('12.5%')).toBeTruthy()
    expect(screen.getByText('CPU · 8 核 · 3.00 GHz')).toBeTruthy()
    expect(screen.getByText('内存 · 16 GB')).toBeTruthy()
    expect(screen.getByText('25.0%')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('80.0%')).toBeTruthy()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('stops automatic sampling in manual mode and refreshes on demand', async () => {
    localStorage.setItem('qingcode.remoteMetricsInterval', '0')
    invoke.mockResolvedValue(snapshot(5))
    render(<dl><RemoteSystemMetricsPanel rootUri="ssh://c1/home/app" /></dl>)
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(invoke).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '立即刷新' }))
    await act(async () => {})
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('shows the backend error inline', async () => {
    invoke.mockRejectedValue(new Error('远端服务版本过旧，更新后可查看系统指标'))
    render(<dl><RemoteSystemMetricsPanel rootUri="ssh://c1/home/app" /></dl>)
    await act(async () => {})
    expect(screen.getByRole('status').textContent).toContain('远端服务版本过旧')
  })
})
