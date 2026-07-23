/**
 * Explorer selection bridge for global copy-path shortcuts.
 * Sidebar keeps the live selection here so Ctrl+Shift+C can prefer the tree
 * when focus is inside the explorer panel (not the active editor tab).
 */

let selectedPath: string | null = null

/** Mark the explorer shell (project header + tree). */
export const EXPLORER_FOCUS_ATTR = 'data-qingcode-explorer'

export function setExplorerSelectedPath(path: string | null): void {
  selectedPath = path
}

export function getExplorerSelectedPath(): string | null {
  return selectedPath
}

/** True when keyboard focus is inside the explorer panel. */
export function isExplorerFocusActive(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement
  return (
    el instanceof HTMLElement && Boolean(el.closest(`[${EXPLORER_FOCUS_ATTR}]`))
  )
}

/**
 * Path to copy for global shortcuts: explorer selection when the tree/panel
 * has focus; otherwise null (caller should use the active editor tab).
 */
export function explorerPathForCopyShortcut(): string | null {
  if (!isExplorerFocusActive()) return null
  return selectedPath
}
