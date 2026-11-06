import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalFontLoader } from '../../mobile/android/web/terminalFont.js'

afterEach(() => { vi.useRealTimers() })

describe('Android terminal symbol font readiness', () => {
  it('waits for the symbol font before resolving and shares one load between terminals', async () => {
    let complete!: () => void
    const fonts = { load: vi.fn(() => new Promise<void>(resolve => { complete = resolve })) }
    const load = createTerminalFontLoader(fonts)
    const first = load()
    expect(load()).toBe(first)
    await Promise.resolve()
    expect(fonts.load).toHaveBeenCalledWith('16px "QingCode Symbols"', '⏴⏵⏶⏷')
    const ready = vi.fn()
    void first.then(ready)
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    complete()
    await first
    expect(ready).toHaveBeenCalledOnce()
    await load()
    expect(fonts.load).toHaveBeenCalledOnce()
  })

  it('allows older WebViews without the Font Loading API to open a terminal', async () => {
    await expect(createTerminalFontLoader(undefined)()).resolves.toBeUndefined()
    await expect(createTerminalFontLoader({})()).resolves.toBeUndefined()
  })

  it('falls back when font loading rejects or throws synchronously', async () => {
    await expect(createTerminalFontLoader({ load: () => Promise.reject(new Error('missing font')) })()).resolves.toBeUndefined()
    await expect(createTerminalFontLoader({ load: () => { throw new Error('unsupported font') } })()).resolves.toBeUndefined()
  })

  it('bounds the initial wait and does not leave timers after a successful load', async () => {
    vi.useFakeTimers()
    const fonts = { load: vi.fn(() => new Promise(() => {})) }
    const load = createTerminalFontLoader(fonts, 1000)
    const ready = vi.fn()
    void load().then(ready)
    await vi.advanceTimersByTimeAsync(999)
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ready).toHaveBeenCalledOnce()
    await load()
    expect(fonts.load).toHaveBeenCalledOnce()
    await createTerminalFontLoader({ load: () => Promise.resolve([]) })()
    expect(vi.getTimerCount()).toBe(0)
  })
})
