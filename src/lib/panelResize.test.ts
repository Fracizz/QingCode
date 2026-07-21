import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginPanelResize,
  PANEL_RESIZE_BEGIN_EVENT,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_SETTLE_EVENT,
  settlePanelResize,
} from './panelResize'

describe('panel resize lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  // 防闪烁回归保护：旧终端画面必须贯穿 settle，直到最终重绘帧才解冻。
  it('keeps the resize lifecycle active until the settle frame completes', () => {
    const classes = new Set<string>()
    const terminalSurface = {
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      getBoundingClientRect: () => ({ width: 801.4, height: 234.6 }),
    }
    const body = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      },
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
    }
    const events: string[] = []
    let settleFrame: FrameRequestCallback | undefined

    vi.stubGlobal('CustomEvent', class {
      constructor(public type: string) {}
    })
    vi.stubGlobal('document', {
      body,
      querySelectorAll: (selector: string) =>
        selector.includes('[data-terminal-active="true"]') || selector.endsWith('.xterm')
          ? [terminalSurface]
          : [],
    })
    vi.stubGlobal('window', {
      dispatchEvent: (event: Event) => {
        events.push(event.type)
        return true
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        settleFrame = callback
        return 1
      },
    })

    beginPanelResize('horizontal')

    expect(events).toEqual([PANEL_RESIZE_BEGIN_EVENT])
    expect(classes.has('panel-resizing')).toBe(true)
    expect(body.dataset.panelResize).toBe('horizontal')
    expect(terminalSurface.dataset.resizeFrozen).toBe('1')
    expect(terminalSurface.style).toMatchObject({
      width: '801px',
      height: '235px',
      maxWidth: 'none',
      maxHeight: 'none',
    })
    settlePanelResize('horizontal')

    expect(events).toEqual([PANEL_RESIZE_BEGIN_EVENT, PANEL_RESIZE_SETTLE_EVENT])
    expect(classes.has('panel-resizing')).toBe(true)
    expect(body.dataset.panelResize).toBe('horizontal')
    expect(terminalSurface.dataset.resizeFrozen).toBe('1')
    settleFrame?.(0)

    expect(events).toEqual([
      PANEL_RESIZE_BEGIN_EVENT,
      PANEL_RESIZE_SETTLE_EVENT,
      PANEL_RESIZE_END_EVENT,
    ])
    expect(classes.has('panel-resizing')).toBe(false)
    expect(body.dataset.panelResize).toBeUndefined()
    expect(terminalSurface.dataset.resizeFrozen).toBeUndefined()
    expect(terminalSurface.style).toMatchObject({
      width: '',
      height: '',
      maxWidth: '',
      maxHeight: '',
    })
  })
})
