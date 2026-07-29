/**
 * Explorer selection bridge for global copy-path shortcuts.
 * Sidebar keeps the live selection here so Ctrl+Shift+C can prefer the tree
 * when focus is inside the explorer panel (not the active editor tab).
 */

let selectedPaths: string[] = []

/** Mark the explorer shell (project header + tree). */
export const EXPLORER_FOCUS_ATTR = 'data-qingcode-explorer'

export function setExplorerSelectedPaths(paths: readonly string[]): void {
  selectedPaths = [...paths]
}

/** Keep a single primary path in sync (first entry / clear). */
export function setExplorerSelectedPath(path: string | null): void {
  selectedPaths = path ? [path] : []
}

export function getExplorerSelectedPath(): string | null {
  return selectedPaths[0] ?? null
}

export function getExplorerSelectedPaths(): readonly string[] {
  return selectedPaths
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
 * Paths to copy for global shortcuts: explorer selection when the tree/panel
 * has focus; otherwise empty (caller should use the active editor tab).
 */
export function explorerPathsForCopyShortcut(): string[] {
  if (!isExplorerFocusActive()) return []
  return [...selectedPaths]
}

/** First explorer path when focused; otherwise null. */
export function explorerPathForCopyShortcut(): string | null {
  return explorerPathsForCopyShortcut()[0] ?? null
}
