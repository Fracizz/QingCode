import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginPanelResize,
  PANEL_RESIZE_BEGIN_EVENT,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_SETTLE_EVENT,
  resolvePanelResizeSpacerSize,
  settlePanelResize,
} from './panelResize'

function terminalSurface(width: number, height: number) {
  return {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ width, height }),
  }
}

describe('panel resize lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lets the spacer follow panel shrink but not panel growth', () => {
    expect(resolvePanelResizeSpacerSize(300, 180)).toBe(180)
    expect(resolvePanelResizeSpacerSize(300, 420)).toBe(300)
  })

  it('freezes only the active terminal until the settle frame completes', () => {
    const active = terminalSurface(640, 240)
    const inactive = terminalSurface(320, 120)
    const surface = terminalSurface(640, 272)
    const classes = new Set<string>()
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
      querySelectorAll: (selector: string) => {
        if (selector.includes('[data-terminal-surface]')) return [surface]
        return selector.includes('[data-terminal-active="true"]') ? [active] : [active, inactive]
      },
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
    expect(active.dataset.resizeFrozen).toBe('1')
    expect(active.style).toMatchObject({
      width: '640px',
      height: '240px',
      maxWidth: 'none',
      maxHeight: 'none',
    })
    expect(inactive.dataset.resizeFrozen).toBeUndefined()
    expect(surface.dataset.resizeLayoutFrozen).toBe('1')
    expect(surface.style).toMatchObject({ height: '272px', flex: 'none' })

    settlePanelResize('horizontal')

    expect(events).toEqual([PANEL_RESIZE_BEGIN_EVENT, PANEL_RESIZE_SETTLE_EVENT])
    expect(active.dataset.resizeFrozen).toBe('1')
    expect(classes.has('panel-resizing')).toBe(true)
    expect(body.dataset.panelResize).toBe('horizontal')
    expect(surface.dataset.resizeLayoutFrozen).toBeUndefined()
    expect(surface.style).toMatchObject({ height: '', flex: '' })

    settleFrame?.(0)

    expect(events).toEqual([
      PANEL_RESIZE_BEGIN_EVENT,
      PANEL_RESIZE_SETTLE_EVENT,
      PANEL_RESIZE_END_EVENT,
    ])
    expect(active.dataset.resizeFrozen).toBeUndefined()
    expect(active.style).toMatchObject({ width: '', height: '', maxWidth: '', maxHeight: '' })
    expect(classes.has('panel-resizing')).toBe(false)
    expect(body.dataset.panelResize).toBeUndefined()
  })
})
