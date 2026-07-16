const RESIZING_CLASS = 'panel-resizing'

export type PanelResizeOrientation = 'horizontal' | 'vertical'

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
}
