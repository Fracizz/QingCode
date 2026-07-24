export const SIDE_EDITOR_COLLAPSED_KEY = 'qingcode:side-editor-collapsed'

/** Side-terminal layout hides the editor column by default. */
export const DEFAULT_SIDE_EDITOR_COLLAPSED = true

export function loadSideEditorCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(SIDE_EDITOR_COLLAPSED_KEY)
    if (raw == null) return DEFAULT_SIDE_EDITOR_COLLAPSED
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
    return DEFAULT_SIDE_EDITOR_COLLAPSED
  } catch {
    return DEFAULT_SIDE_EDITOR_COLLAPSED
  }
}

export function saveSideEditorCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDE_EDITOR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {}
}
