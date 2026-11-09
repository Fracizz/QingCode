export const PANEL_LAYOUT_KEY = 'qingcode:panel-layout'
export const PANEL_LAYOUT_CHANGED_EVENT = 'qingcode:panel-layout-changed'

/**
 * classic = terminal bottom; sideTerminal = sidebar | editor | terminal;
 * terminalWorkbench = terminal list | terminal | editor (on demand).
 */
export type PanelLayoutTemplate = 'classic' | 'sideTerminal' | 'terminalWorkbench'

export const DEFAULT_PANEL_LAYOUT: PanelLayoutTemplate = 'classic'


export function parsePanelLayoutTemplate(value: unknown): PanelLayoutTemplate {
  if (value === 'classic' || value === 'sideTerminal' || value === 'terminalWorkbench') return value
  return DEFAULT_PANEL_LAYOUT
}

export function loadPanelLayoutTemplate(): PanelLayoutTemplate {
  try {
    return parsePanelLayoutTemplate(localStorage.getItem(PANEL_LAYOUT_KEY))
  } catch {
    return DEFAULT_PANEL_LAYOUT
  }
}

export function terminalPositionForTemplate(
  template: PanelLayoutTemplate,
): 'bottom' | 'side' {
  return template === 'sideTerminal' || template === 'terminalWorkbench' ? 'side' : 'bottom'
}

/**
 * 拖动终端宽度分隔条时，指针右移一像素对终端宽度的影响：
 * 侧栏布局分隔条在终端左缘（右移变窄），工作台在右缘（右移变宽）。
 */
export function terminalWidthDragSign(template: PanelLayoutTemplate): 1 | -1 {
  return template === 'terminalWorkbench' ? 1 : -1
}

export function nextPanelLayoutTemplate(
  current: PanelLayoutTemplate,
): PanelLayoutTemplate {
  return current === 'classic' ? 'sideTerminal' : 'classic'
}

function notifyPanelLayoutChanged(template: PanelLayoutTemplate) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(PANEL_LAYOUT_CHANGED_EVENT, { detail: { template } }),
  )
}

export function savePanelLayoutTemplate(template: PanelLayoutTemplate) {
  const next = parsePanelLayoutTemplate(template)
  try {
    localStorage.setItem(PANEL_LAYOUT_KEY, next)
  } catch {}
  notifyPanelLayoutChanged(next)
}

export function cyclePanelLayoutTemplate(): PanelLayoutTemplate {
  const next = nextPanelLayoutTemplate(loadPanelLayoutTemplate())
  savePanelLayoutTemplate(next)
  return next
}
