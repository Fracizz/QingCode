import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalFontLoader } from '../../mobile/android/web/terminalFont.js'

afterEach(() => { vi.useRealTimers() })

describe('Android terminal symbol font readiness', () => {
  it('waits for the symbol and CJK fonts before resolving and shares one load between terminals', async () => {
    const pending: Array<() => void> = []
    const complete = () => { for (const resolve of pending) resolve() }
    const fonts = { load: vi.fn(() => new Promise<void>(resolve => { pending.push(resolve) })) }
    const load = createTerminalFontLoader(fonts)
    const first = load()
    expect(load()).toBe(first)
    await Promise.resolve()
    expect(fonts.load).toHaveBeenCalledWith('16px "QingCode Symbols"', '⏴⏵⏶⏷')
    // 中文字形也要在建终端前就绪，WebGL 渲染会缓存首次绘制的回退字形。
    expect(fonts.load).toHaveBeenCalledWith('16px "QingCode CJK"', '中文')
    const ready = vi.fn()
    void first.then(ready)
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    complete()
    await first
    expect(ready).toHaveBeenCalledOnce()
    await load()
    expect(fonts.load).toHaveBeenCalledTimes(2)
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
    expect(fonts.load).toHaveBeenCalledTimes(2)
    await createTerminalFontLoader({ load: () => Promise.resolve([]) })()
    expect(vi.getTimerCount()).toBe(0)
  })
})
