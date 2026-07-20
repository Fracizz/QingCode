const RESIZING_CLASS = 'panel-resizing'

export type PanelResizeOrientation = 'horizontal' | 'vertical'

/** Fired on `window` after a panel sash drag ends (xterm / minimap can settle). */
export const PANEL_RESIZE_END_EVENT = 'qingcode:panel-resize-end'

export function isPanelResizing(): boolean {
  return document.body.classList.contains(RESIZING_CLASS)
}

export function beginPanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  document.body.classList.add(RESIZING_CLASS)
  document.body.dataset.panelResize = orientation
  document.body.style.userSelect = 'none'
}

export function endPanelResize(_orientation: PanelResizeOrientation = 'horizontal') {
  document.body.classList.remove(RESIZING_CLASS)
  delete document.body.dataset.panelResize
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_END_EVENT))
}
