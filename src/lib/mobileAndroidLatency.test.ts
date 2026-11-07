// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectionLatency, HOME_LATENCY_INTERVAL, isFreshLatency, TERMINAL_LATENCY_INTERVAL, latencyText } from '../../mobile/android/web/connectionLatency.js'

const a = { id: '192.168.1.8:48764', fingerprint: 'a' }
const b = { id: '10.0.0.9:48764', fingerprint: 'b' }
const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.useRealTimers() })
describe('isFreshLatency', () => {
  it('fires once per successful probe and never for failures', () => {
    const ready = { milliseconds: 32, checkedAt: 1000, state: 'ready' }
    expect(isFreshLatency(ready, null)).toBe(true)
    expect(isFreshLatency(ready, 1000)).toBe(false)
    expect(isFreshLatency({ ...ready, checkedAt: 2000 }, 1000)).toBe(true)
    for (const state of ['failed', 'stale', 'unsupported', 'idle']) expect(isFreshLatency({ milliseconds: null, checkedAt: 2000, state }, 1000)).toBe(false)
    expect(isFreshLatency({ milliseconds: 32, checkedAt: null, state: 'ready' }, null)).toBe(false)
  })
})

function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  let hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const measure = vi.fn().mockResolvedValue({ supported: true, milliseconds: 32.4 })
  const onChange = vi.fn()
  const sampler = createConnectionLatency({ measure, onChange })
  disposers.push(sampler.dispose)
  const visibility = (value: boolean) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')) }
  return { sampler, measure, onChange, visibility }
}
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('Android connection latency', () => {
  it('shares a sample across views and uses 30s at home and 10s in terminals', async () => {
    const { sampler, measure } = fixture()
    sampler.setTarget(a, HOME_LATENCY_INTERVAL)
    await settle()
    expect(measure).toHaveBeenCalledExactlyOnceWith(a.id)
    sampler.setTarget({ ...a, name: 'renamed' }, TERMINAL_LATENCY_INTERVAL)
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await vi.advanceTimersByTimeAsync(9999)
    expect(measure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(measure).toHaveBeenCalledTimes(2)
    sampler.setTarget(a, HOME_LATENCY_INTERVAL)
    await vi.advanceTimersByTimeAsync(29999)
    expect(measure).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(measure).toHaveBeenCalledTimes(3)
  })

  it('never overlaps probes or lets a late result overwrite another computer', async () => {
    const { sampler, measure, onChange } = fixture()
    let finish!: (result: object) => void
    measure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    sampler.setTarget(b, TERMINAL_LATENCY_INTERVAL)
    await vi.advanceTimersByTimeAsync(10000)
    expect(measure).toHaveBeenCalledTimes(1)
    finish({ supported: true, milliseconds: 999 })
    await settle()
    expect(measure).toHaveBeenLastCalledWith(b.id)
    expect(sampler.getSnapshot().milliseconds).toBe(32.4)
    expect(onChange.mock.calls.some(([value]) => value.milliseconds === 999)).toBe(false)
  })

  it('expires an old success even while its replacement probe is still pending', async () => {
    const { sampler, measure } = fixture()
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await settle()
    measure.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(30000)
    expect(measure).toHaveBeenCalledTimes(2)
    expect(sampler.getSnapshot()).toMatchObject({ milliseconds: null, state: 'stale' })
  })

  it('pauses in the background and immediately resamples on foreground return', async () => {
    const { sampler, measure, visibility } = fixture()
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await settle()
    visibility(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(measure).toHaveBeenCalledTimes(1)
    visibility(false)
    await settle()
    expect(measure).toHaveBeenCalledTimes(2)
    expect(sampler.getSnapshot().milliseconds).toBe(32.4)
  })

  it('rejects a probe that completed while the page was hidden', async () => {
    const { sampler, measure, visibility } = fixture()
    let finish!: (result: object) => void
    measure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    visibility(true)
    finish({ supported: true, milliseconds: 900 })
    await settle()
    expect(sampler.getSnapshot().milliseconds).toBeNull()
    visibility(false)
    await settle()
    expect(sampler.getSnapshot().milliseconds).toBe(32.4)
  })

  it('also pauses from the Android lifecycle when document visibility has not changed', async () => {
    const { sampler, measure } = fixture()
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await settle()
    sampler.setForeground(false)
    await vi.advanceTimersByTimeAsync(60000)
    expect(measure).toHaveBeenCalledTimes(1)
    sampler.setForeground(true)
    await settle()
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('clears a failed measurement and can recover without changing business state', async () => {
    const { sampler, measure } = fixture()
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await settle()
    measure.mockRejectedValueOnce(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(sampler.getSnapshot()).toMatchObject({ milliseconds: null, state: 'failed' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(sampler.getSnapshot()).toMatchObject({ milliseconds: 32.4, state: 'ready' })
  })

  it('stops unsupported probes until the pairing is explicitly invalidated', async () => {
    const { sampler, measure } = fixture()
    measure.mockResolvedValueOnce({ supported: false })
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await settle()
    expect(sampler.getSnapshot().state).toBe('unsupported')
    await vi.advanceTimersByTimeAsync(60000)
    sampler.setTarget(a, HOME_LATENCY_INTERVAL)
    await settle()
    expect(measure).toHaveBeenCalledTimes(1)
    sampler.invalidate(a.id)
    await settle()
    expect(sampler.getSnapshot().milliseconds).toBe(32.4)
  })

  it('clears old measurements when the certificate, endpoint, or active connection changes', async () => {
    const { sampler, measure } = fixture()
    sampler.setTarget(a, TERMINAL_LATENCY_INTERVAL)
    await settle()
    measure.mockImplementation(() => new Promise(() => {}))
    sampler.setTarget({ ...a, fingerprint: 'new' }, TERMINAL_LATENCY_INTERVAL)
    expect(sampler.getSnapshot().milliseconds).toBeNull()
    sampler.setTarget(null)
    await vi.advanceTimersByTimeAsync(60000)
    expect(sampler.getSnapshot()).toMatchObject({ milliseconds: null, checkedAt: null })
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it.each([NaN, -1, Infinity, '32', undefined])('rejects an invalid native measurement: %s', async value => {
    const { sampler, measure } = fixture()
    measure.mockResolvedValueOnce({ supported: true, milliseconds: value })
    sampler.setTarget(a)
    await settle()
    expect(sampler.getSnapshot()).toMatchObject({ milliseconds: null, state: 'failed' })
  })

  it('disposal rejects late results and removes all scheduled work', async () => {
    const { sampler, measure, onChange, visibility } = fixture()
    let finish!: (result: object) => void
    measure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    sampler.setTarget(a)
    sampler.dispose()
    const count = onChange.mock.calls.length
    finish({ supported: true, milliseconds: 100 })
    visibility(true)
    visibility(false)
    await vi.advanceTimersByTimeAsync(60000)
    expect(onChange).toHaveBeenCalledTimes(count)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('formats sub-millisecond and unavailable values clearly', () => {
    expect(latencyText({ milliseconds: null })).toBe('--')
    expect(latencyText({ milliseconds: 0.4 })).toBe('<1 ms')
    expect(latencyText({ milliseconds: 32.4 })).toBe('32 ms')
  })
})
