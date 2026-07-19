export const PANEL_LAYOUT_KEY = 'qingcode:panel-layout'
export const PANEL_LAYOUT_CHANGED_EVENT = 'qingcode:panel-layout-changed'

/** classic = terminal bottom; sideTerminal = sidebar | terminal | editor */
export type PanelLayoutTemplate = 'classic' | 'sideTerminal'

export const DEFAULT_PANEL_LAYOUT: PanelLayoutTemplate = 'classic'

export const PANEL_LAYOUT_TEMPLATES: PanelLayoutTemplate[] = ['classic', 'sideTerminal']

export function parsePanelLayoutTemplate(value: unknown): PanelLayoutTemplate {
  if (value === 'classic' || value === 'sideTerminal') return value
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
  return template === 'sideTerminal' ? 'side' : 'bottom'
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
