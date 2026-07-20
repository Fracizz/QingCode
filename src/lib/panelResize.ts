const RESIZING_CLASS = 'panel-resizing'

export type PanelResizeOrientation = 'horizontal' | 'vertical'

/** Fired when a panel sash drag starts / ends. */
export const PANEL_RESIZE_BEGIN_EVENT = 'qingcode:panel-resize-begin'
export const PANEL_RESIZE_SETTLE_EVENT = 'qingcode:panel-resize-settle'
export const PANEL_RESIZE_END_EVENT = 'qingcode:panel-resize-end'

export function isPanelResizing(): boolean {
  return document.body.classList.contains(RESIZING_CLASS)
}

/** Fill released editor space while keeping terminal growth as an overlay. */
export function resolvePanelResizeSpacerSize(initialSize: number, liveSize: number): number {
  return Math.min(initialSize, liveSize)
}

/**
 * Pin xterm's last-fit CSS box so WebView2 does not stretch/rebuild the WebGL
 * canvas while the panel sash moves.
 */
function freezeTerminalSurfaces() {
  document
    .querySelectorAll<HTMLElement>('[data-terminal-dock] [data-terminal-active="true"] .xterm')
    .forEach(el => {
      if (el.dataset.resizeFrozen === '1') return
      const rect = el.getBoundingClientRect()
      el.dataset.resizeFrozen = '1'
      el.style.width = `${Math.round(rect.width)}px`
      el.style.height = `${Math.round(rect.height)}px`
      el.style.maxWidth = 'none'
      el.style.maxHeight = 'none'
    })
}

function unfreezeTerminalSurfaces() {
  document.querySelectorAll<HTMLElement>('[data-terminal-dock] .xterm').forEach(el => {
    if (el.dataset.resizeFrozen !== '1') return
    delete el.dataset.resizeFrozen
    el.style.width = ''
    el.style.height = ''
    el.style.maxWidth = ''
    el.style.maxHeight = ''
  })
}

export function beginPanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  document.body.classList.add(RESIZING_CLASS)
  document.body.dataset.panelResize = orientation
  document.body.style.userSelect = 'none'
  freezeTerminalSurfaces()
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_BEGIN_EVENT))
}

/** Fit the final grid while its old surface is still clipped, then reveal it next frame. */
export function settlePanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_SETTLE_EVENT))
  window.requestAnimationFrame(() => endPanelResize(orientation))
}

export function endPanelResize(_orientation: PanelResizeOrientation = 'horizontal') {
  unfreezeTerminalSurfaces()
  document.body.classList.remove(RESIZING_CLASS)
  delete document.body.dataset.panelResize
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_END_EVENT))
}
