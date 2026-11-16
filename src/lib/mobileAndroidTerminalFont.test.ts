import { afterEach, describe, expect, it, vi } from 'vitest'
import { CJK_FONT_FAMILY, CJK_SIZE_ADJUST, createCjkFontFace, createTerminalFontLoader } from '../../mobile/android/web/terminalFont.js'

afterEach(() => { vi.useRealTimers() })

describe('Android terminal symbol font readiness', () => {
  it('waits for the symbol font before resolving and shares one load between terminals', async () => {
    const pending: Array<() => void> = []
    const complete = () => { for (const resolve of pending) resolve() }
    const fonts = { load: vi.fn(() => new Promise<void>(resolve => { pending.push(resolve) })) }
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

  it('registers and waits for the Android CJK face only when one is provided', async () => {
    // 中文字形也要在建终端前就绪，WebGL 渲染会缓存首次绘制的回退字形。
    let complete!: () => void
    const face = { load: vi.fn(() => new Promise<void>(resolve => { complete = resolve })) }
    const fonts = { load: vi.fn(() => Promise.resolve()), add: vi.fn() }
    const ready = vi.fn()
    void createTerminalFontLoader(fonts, 2500, { cjkFace: () => face })().then(ready)
    await vi.waitFor(() => expect(fonts.add).toHaveBeenCalledWith(face))
    expect(ready).not.toHaveBeenCalled()
    complete()
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    // 没有提供（桌面浏览器）时不注册。
    const desktop = { load: vi.fn(() => Promise.resolve()), add: vi.fn() }
    await createTerminalFontLoader(desktop, 2500, { cjkFace: () => null })()
    expect(desktop.add).not.toHaveBeenCalled()
  })

  it('builds the CJK face with local system fonts, CJK-only range and size adjust', () => {
    const FontFaceType = vi.fn(function (this: Record<string, unknown>, family: string, source: string, descriptors: Record<string, string>) {
      Object.assign(this, { family, source, descriptors })
    })
    const face = createCjkFontFace(FontFaceType) as unknown as { family: string, source: string, descriptors: Record<string, string> }
    expect(face.family).toBe(CJK_FONT_FAMILY)
    expect(face.source).toContain("local('Noto Sans CJK SC')")
    expect(face.descriptors.sizeAdjust).toBe(CJK_SIZE_ADJUST)
    expect(face.descriptors.unicodeRange).toContain('U+4E00-9FFF')
    // 半角片假名等窄字符不放大。
    expect(face.descriptors.unicodeRange).not.toContain('U+FF00-FFEF')
    expect(createCjkFontFace(undefined)).toBeNull()
    expect(createCjkFontFace(function () { throw new Error('unsupported') })).toBeNull()
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
