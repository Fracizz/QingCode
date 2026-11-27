// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BackendCallError, call } from '../lib/backend'
import { TargetMetrics } from './TargetMetrics'

vi.mock('../lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/backend')>(),
  call: vi.fn(),
}))

const request = vi.mocked(call)
const GiB = 1024 ** 3
const snapshot = { cpuThreads: 8, cpuUsage: 23.4, memoryUsed: 12.5 * GiB, memoryTotal: 32 * GiB }
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  request.mockReset()
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('刷新目标机指标，窗口隐藏时暂停并在恢复可见后立即刷新', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  request.mockResolvedValue(snapshot)
  await act(() => root.render(<TargetMetrics targetId="remote" />))

  expect(request).toHaveBeenCalledExactlyOnceWith('server.req', { targetId: 'remote', method: 'system.metrics' })
  expect(host.textContent).toContain('CPU 23.4%')
  expect(host.querySelector('[title^="内存已用"]')?.getAttribute('title')).toBe('内存已用 12.5/32 GiB · 39.1%')

  request.mockResolvedValue({ ...snapshot, cpuUsage: 95 })
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(host.querySelector('.text-qn-danger')?.textContent).toBe('95.0%')

  hidden.mockReturnValue(true)
  document.dispatchEvent(new Event('visibilitychange'))
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(request).toHaveBeenCalledTimes(2)

  hidden.mockReturnValue(false)
  await act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(request).toHaveBeenCalledTimes(3)
})

it('切换到较旧的目标机后丢弃前一台的响应并停止轮询', async () => {
  let resolvePrevious!: (value: typeof snapshot) => void
  const previous = new Promise<typeof snapshot>((resolve) => { resolvePrevious = resolve })
  request.mockReturnValueOnce(previous)
    .mockRejectedValue(new BackendCallError('method', '未知方法: system.metrics'))

  await act(() => root.render(<TargetMetrics key="remote" targetId="remote" />))
  await act(() => root.render(<TargetMetrics key="local" targetId="local" />))
  await act(() => resolvePrevious(snapshot))
  await act(() => vi.advanceTimersByTimeAsync(10_000))

  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenLastCalledWith('server.req', { targetId: 'local', method: 'system.metrics' })
  expect(host.textContent).toBe('')
})
