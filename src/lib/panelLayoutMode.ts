import type { PanelLayoutTemplate } from './panelLayoutTemplate'
import type { SideWorkspaceColumns } from './sideWorkspaceLayout'

/**
 * Title-bar / shortcut layout choices.
 * Dual-only (no editor) is not a menu preset — use terminal chrome to hide the editor.
 */
export type PanelLayoutMode = 'classic' | 'sideTerminal' | 'sideDualEditor'

/** Legacy aliases still accepted by setters / commands. */
export type PanelLayoutPreset = PanelLayoutMode | 'sideDual' | 'sideTerminalCollapsed'

/** Cycle order for the layout shortcut. */
export const PANEL_LAYOUT_MODES: PanelLayoutMode[] = [
  'classic',
  'sideTerminal',
  'sideDualEditor',
]

/** Title-bar menu order. */
export const PANEL_LAYOUT_MENU_MODES: PanelLayoutMode[] = [
  'classic',
  'sideTerminal',
  'sideDualEditor',
]

export function resolvePanelLayoutMode(
  panelLayout: PanelLayoutTemplate,
  columns: SideWorkspaceColumns,
): PanelLayoutMode {
  if (panelLayout === 'classic') return 'classic'
  if (columns.dualTerminal) return 'sideDualEditor'
  return 'sideTerminal'
}

export function panelLayoutModeParts(mode: PanelLayoutPreset): {
  panelLayout: PanelLayoutTemplate
  columns: SideWorkspaceColumns | null
} {
  switch (mode) {
    case 'classic':
      return { panelLayout: 'classic', columns: null }
    case 'sideTerminal':
      return {
        panelLayout: 'sideTerminal',
        columns: { dualTerminal: false, editorVisible: true },
      }
    case 'sideDual':
    case 'sideTerminalCollapsed':
    case 'sideDualEditor':
      return {
        panelLayout: 'sideTerminal',
        columns: { dualTerminal: true, editorVisible: true },
      }
  }
}

export function nextPanelLayoutMode(current: PanelLayoutMode): PanelLayoutMode {
  const index = PANEL_LAYOUT_MODES.indexOf(current)
  return PANEL_LAYOUT_MODES[(index + 1) % PANEL_LAYOUT_MODES.length] ?? 'classic'
}

export function panelLayoutModeLabel(mode: PanelLayoutPreset): string {
  switch (mode) {
    case 'classic':
      return '经典布局（终端在底部）'
    case 'sideTerminal':
      return '终端+编辑器'
    case 'sideDual':
    case 'sideTerminalCollapsed':
    case 'sideDualEditor':
      return '双终端+编辑器'
  }
}

export function normalizePanelLayoutMode(mode: PanelLayoutPreset): PanelLayoutMode {
  if (mode === 'sideDual' || mode === 'sideTerminalCollapsed') return 'sideDualEditor'
  return mode
}
