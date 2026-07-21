const RESIZING_CLASS = 'panel-resizing'

export type PanelResizeOrientation = 'horizontal' | 'vertical'

/** 面板分隔条开始、最终对齐与结束拖动事件。 */
export const PANEL_RESIZE_BEGIN_EVENT = 'qingcode:panel-resize-begin'
export const PANEL_RESIZE_SETTLE_EVENT = 'qingcode:panel-resize-settle'
export const PANEL_RESIZE_END_EVENT = 'qingcode:panel-resize-end'

export function isPanelResizing(): boolean {
  return document.body.classList.contains(RESIZING_CLASS)
}

/**
 * Keep the last completed xterm frame visible while its parent flex box moves.
 *
 * Resizing the WebGL canvas clears it synchronously, while xterm redraws on the
 * next animation frame. Pinning the surface prevents ResizeObserver from
 * resizing that canvas in a frame that WebView2 could present as empty.
 */
function freezeTerminalSurfaces() {
  document
    .querySelectorAll<HTMLElement>('[data-terminal-dock] [data-terminal-active="true"] .xterm')
    .forEach(surface => {
      if (surface.dataset.resizeFrozen === '1') return
      const rect = surface.getBoundingClientRect()
      surface.dataset.resizeFrozen = '1'
      surface.style.width = `${Math.round(rect.width)}px`
      surface.style.height = `${Math.round(rect.height)}px`
      surface.style.maxWidth = 'none'
      surface.style.maxHeight = 'none'
    })
}

function unfreezeTerminalSurfaces() {
  document.querySelectorAll<HTMLElement>('[data-terminal-dock] .xterm').forEach(surface => {
    if (surface.dataset.resizeFrozen !== '1') return
    delete surface.dataset.resizeFrozen
    surface.style.width = ''
    surface.style.height = ''
    surface.style.maxWidth = ''
    surface.style.maxHeight = ''
  })
}

export function beginPanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  document.body.classList.add(RESIZING_CLASS)
  document.body.dataset.panelResize = orientation
  document.body.style.userSelect = 'none'
  freezeTerminalSurfaces()
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_BEGIN_EVENT))
}

/**
 * Submit the final grid while the old surface remains pinned. xterm schedules
 * its redraw first; the later callback reveals the completed WebGL frame.
 */
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
