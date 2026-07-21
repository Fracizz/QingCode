const RESIZING_CLASS = 'panel-resizing'

export type PanelResizeOrientation = 'horizontal' | 'vertical'

/** 面板分隔条开始、最终对齐与结束拖动事件。 */
export const PANEL_RESIZE_BEGIN_EVENT = 'qingcode:panel-resize-begin'
export const PANEL_RESIZE_SETTLE_EVENT = 'qingcode:panel-resize-settle'
export const PANEL_RESIZE_END_EVENT = 'qingcode:panel-resize-end'

export function isPanelResizing(): boolean {
  return document.body.classList.contains(RESIZING_CLASS)
}

export function beginPanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  document.body.classList.add(RESIZING_CLASS)
  document.body.dataset.panelResize = orientation
  document.body.style.userSelect = 'none'
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_BEGIN_EVENT))
}

/** 先提交最终字符网格，下一帧再恢复普通布局监听。 */
export function settlePanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_SETTLE_EVENT))
  window.requestAnimationFrame(() => endPanelResize(orientation))
}

export function endPanelResize(_orientation: PanelResizeOrientation = 'horizontal') {
  document.body.classList.remove(RESIZING_CLASS)
  delete document.body.dataset.panelResize
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_END_EVENT))
}
