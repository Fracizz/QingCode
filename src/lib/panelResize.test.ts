import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginPanelResize,
  PANEL_RESIZE_BEGIN_EVENT,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_SETTLE_EVENT,
  settlePanelResize,
  type PanelResizeSettleDetail,
} from './panelResize'

function classList(initial: string[] = []) {
  const classes = new Set(initial)
  return {
    add: (name: string) => classes.add(name),
    remove: (name: string) => classes.delete(name),
    contains: (name: string) => classes.has(name),
  }
}

describe('panel resize lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  // 防闪烁回归保护：不能再用“一个固定 rAF”代替 xterm 的真实 onRender 完成信号。
  it('keeps the canvas snapshot until render readiness and one compositor frame', async () => {
    const sourceCanvas = {
      getBoundingClientRect: () => ({ left: 12, top: 24, width: 780, height: 220 }),
    }
    const surface = {
      parentElement: null as unknown,
      dataset: {} as Record<string, string>,
      querySelectorAll: () => [sourceCanvas],
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 801.4, height: 234.6 }),
    }
    const hostClasses = classList()
    const appendChild = vi.fn()
    const host = {
      classList: hostClasses,
      appendChild,
    }
    surface.parentElement = host

    const drawImage = vi.fn()
    const snapshot = {
      width: 0,
      height: 0,
      className: '',
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      getContext: () => ({
        setTransform: vi.fn(),
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage,
      }),
      remove: vi.fn(),
    }
    const bodyClasses = classList()
    const body = {
      classList: bodyClasses,
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
    }

    const events: string[] = []
    let settleFrame: FrameRequestCallback | undefined
    let resolveRender!: () => void
    const renderReady = new Promise<void>(resolve => {
      resolveRender = resolve
    })

    vi.stubGlobal(
      'CustomEvent',
      class<T> {
        detail: T | undefined
        constructor(
          public type: string,
          init?: { detail?: T }
        ) {
          this.detail = init?.detail
        }
      }
    )
    vi.stubGlobal('document', {
      body,
      querySelectorAll: () => [surface],
      createElement: () => snapshot,
    })
    vi.stubGlobal('window', {
      devicePixelRatio: 2,
      getComputedStyle: () => ({
        backgroundColor: '#101820',
        getPropertyValue: () => '',
      }),
      dispatchEvent: (event: { type: string; detail?: PanelResizeSettleDetail }) => {
        events.push(event.type)
        if (event.type === PANEL_RESIZE_SETTLE_EVENT) event.detail?.waitUntil(renderReady)
        return true
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        settleFrame = callback
        return 1
      },
      cancelAnimationFrame: vi.fn(),
      setTimeout: vi.fn(() => 2),
      clearTimeout: vi.fn(),
    })

    beginPanelResize('horizontal')

    expect(events).toEqual([PANEL_RESIZE_BEGIN_EVENT])
    expect(bodyClasses.contains('panel-resizing')).toBe(true)
    expect(surface.dataset.resizeFrozen).toBe('1')
    expect(snapshot.width).toBe(1603)
    expect(snapshot.height).toBe(469)
    expect(snapshot.style).toMatchObject({ width: '801.4px', height: '234.6px' })
    expect(hostClasses.contains('terminal-resize-snapshot-host')).toBe(true)
    expect(appendChild).toHaveBeenCalledWith(snapshot)
    expect(drawImage).toHaveBeenCalledOnce()

    settlePanelResize('horizontal')
    await Promise.resolve()

    expect(events).toEqual([PANEL_RESIZE_BEGIN_EVENT, PANEL_RESIZE_SETTLE_EVENT])
    expect(settleFrame).toBeUndefined()
    expect(snapshot.remove).not.toHaveBeenCalled()

    resolveRender()
    await renderReady
    await Promise.resolve()
    await Promise.resolve()

    expect(settleFrame).toBeTypeOf('function')
    expect(snapshot.remove).not.toHaveBeenCalled()
    settleFrame?.(0)

    expect(events).toEqual([
      PANEL_RESIZE_BEGIN_EVENT,
      PANEL_RESIZE_SETTLE_EVENT,
      PANEL_RESIZE_END_EVENT,
    ])
    expect(bodyClasses.contains('panel-resizing')).toBe(false)
    expect(surface.dataset.resizeFrozen).toBeUndefined()
    expect(snapshot.remove).toHaveBeenCalledOnce()
    expect(hostClasses.contains('terminal-resize-snapshot-host')).toBe(false)
  })
})
