// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConnectionLatency, invalidateConnectionLatency, subscribeConnectionLatency } from './connectionLatency'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('./tauri', () => ({ safeInvoke: invoke }))
vi.mock('./sshWorkspace', () => ({
  SSH_CONNECTION_INVALIDATED_EVENT: 'qingcode:ssh-connection-invalidated',
  SSH_CONNECTION_DISCONNECTED_EVENT: 'qingcode:ssh-connection-disconnected',
}))
const root = 'ssh://latency-test/project'
const stops: Array<() => void> = []
const subscribe = (uri = root) => {
  const listener = vi.fn()
  stops.push(subscribeConnectionLatency(uri, listener))
  return listener
}
const visible = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('shared connection latency sampler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    visible('visible')
    invoke.mockReset().mockResolvedValue(28.4)
  })
  afterEach(() => {
    stops.splice(0).forEach(stop => stop())
    invalidateConnectionLatency(root)
    vi.useRealTimers()
  })

  it('samples immediately, shares across project roots, and keeps running after its first subscriber leaves', async () => {
    subscribe()
    const other = 'ssh://latency-test/other'
    subscribe(other)
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(getConnectionLatency(root)).toBe(getConnectionLatency(other))
    expect(getConnectionLatency(root).milliseconds).toBe(28.4)
    stops.shift()!()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(invoke).toHaveBeenLastCalledWith(expect.any(String), 'ssh_server_latency', { rootUri: other })
    stops.shift()!()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(getConnectionLatency(root).milliseconds).toBeNull()
  })

  it('pauses while hidden and samples again on visibility restoration without overlapping requests', async () => {
    visible('hidden')
    subscribe()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).not.toHaveBeenCalled()
    let finish!: (ms: number) => void
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    visible('visible')
    visible('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    finish(12)
    await vi.advanceTimersByTimeAsync(0)
    visible('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    visible('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('reuses a fresh sample when switching projects and clears it on connection invalidation', async () => {
    subscribe()
    await vi.advanceTimersByTimeAsync(0)
    stops.shift()!()
    await vi.advanceTimersByTimeAsync(5_000)
    subscribe('ssh://latency-test/other')
    expect(getConnectionLatency(root).milliseconds).toBe(28.4)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(invoke).toHaveBeenCalledTimes(2)
    stops.shift()!()
    window.dispatchEvent(new CustomEvent('qingcode:ssh-connection-invalidated', { detail: 'latency-test' }))
    subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('clears failed or malformed samples and retries at the regular interval', async () => {
    subscribe()
    await vi.advanceTimersByTimeAsync(0)
    invoke.mockRejectedValueOnce(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getConnectionLatency(root)).toEqual({ milliseconds: null, checkedAt: expect.any(Number) })
    invoke.mockResolvedValueOnce(-1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getConnectionLatency(root).milliseconds).toBeNull()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getConnectionLatency(root).milliseconds).toBe(28.4)
  })

  it('discards an old in-flight sample after disconnect and reconnect', async () => {
    let finish!: (ms: number) => void
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    subscribe()
    stops.shift()!()
    subscribe()
    await vi.advanceTimersByTimeAsync(0)
    finish(999)
    await vi.advanceTimersByTimeAsync(0)
    expect(getConnectionLatency(root).milliseconds).toBe(28.4)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
