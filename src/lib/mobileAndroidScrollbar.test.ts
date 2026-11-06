// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalScrollbar, offsetForThumb, thumbGeometry } from '../../mobile/android/web/terminalScrollbar.js'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })

describe('Android touch scrollbar geometry', () => {
  it('sizes the thumb by the visible share with a finger-sized minimum', () => {
    expect(thumbGeometry({ total: 200, visible: 100, offset: 0 }, 400)).toEqual({ size: 200, top: 0 })
    expect(thumbGeometry({ total: 200, visible: 100, offset: 100 }, 400)).toEqual({ size: 200, top: 200 })
    expect(thumbGeometry({ total: 100000, visible: 40, offset: 0 }, 400)!.size).toBe(64)
    expect(thumbGeometry({ total: 40, visible: 40, offset: 0 }, 400)).toBeNull()
  })

  it('maps a thumb position back to a clamped scroll offset', () => {
    const metrics = { total: 1040, visible: 40 }
    expect(offsetForThumb(metrics, 400, 48, 0)).toBe(0)
    expect(offsetForThumb(metrics, 400, 48, 176)).toBe(500)
    expect(offsetForThumb(metrics, 400, 48, 999)).toBe(1000)
    expect(offsetForThumb(metrics, 400, 48, -5)).toBe(0)
  })
})

describe('Android touch scrollbar', () => {
  it('stays visible while reading back and hides after returning to the end', () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.append(host)
    let metrics: { total: number, visible: number, offset: number } | null = { total: 100, visible: 20, offset: 10 }
    const scrollbar = attachTerminalScrollbar(host, { metrics: () => metrics, scrollTo: vi.fn(), idleMs: 100 })
    const bar = host.querySelector('.touch-scrollbar') as HTMLElement
    Object.defineProperty(bar, 'clientHeight', { value: 400 })
    scrollbar.update()
    expect(bar.hidden).toBe(false)
    vi.advanceTimersByTime(500)
    expect(bar.hidden).toBe(false)
    metrics = { total: 100, visible: 20, offset: 80 }
    scrollbar.update()
    vi.advanceTimersByTime(150)
    expect(bar.hidden).toBe(true)
    metrics = null
    scrollbar.update()
    expect(bar.hidden).toBe(true)
    scrollbar.dispose()
    expect(host.querySelector('.touch-scrollbar')).toBeNull()
  })
})
