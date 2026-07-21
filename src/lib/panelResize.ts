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
 * 【终端防闪烁关键逻辑，请勿轻易修改或删除】
 *
 * 拖动面板时必须固定 xterm 最后一张完整画面的像素尺寸。WebGL canvas 在
 * resize 时会同步清空，但 xterm 要到下一帧才重绘；如果拖动中解除固定，
 * WebView2 会合成出空白帧，表现为终端界面闪烁。
 *
 * 修改这里时必须同时检查 Terminal.tsx 的 ResizeObserver / settle 逻辑，
 * 并在 Tauri 窗口中连续上下拖动终端面板验证无文字消失或白/黑帧。
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
 * 【终端防闪烁关键时序，请勿改成直接 endPanelResize】
 *
 * settle 事件先让 Terminal.tsx 提交最终字符网格，此时旧画面仍处于冻结状态；
 * xterm 会先注册重绘帧，随后这里注册解冻帧，从而保证展示的是完成后的 WebGL
 * 画面。调整事件顺序或提前解冻都会重新引入拖动结束闪烁。
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
