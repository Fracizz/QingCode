export const SIDEBAR_WIDTH_KEY = 'qingcode:sidebar-width'

export const SIDEBAR_DEFAULT_WIDTH = 320
/** Old factory default — migrate so existing installs pick up the wider sidebar. */
const SIDEBAR_LEGACY_DEFAULT_WIDTH = 260
/** Previous default before 320px — migrate on load. */
const SIDEBAR_PREVIOUS_DEFAULT_WIDTH = 300
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 520
export const SIDEBAR_EDITOR_MIN_WIDTH = 320
export const ACTIVITY_BAR_WIDTH = 48

export function clampSidebarWidth(width: number): number {
  const maxByWindow = window.innerWidth - ACTIVITY_BAR_WIDTH - SIDEBAR_EDITOR_MIN_WIDTH
  const max = Math.min(SIDEBAR_MAX_WIDTH, maxByWindow)
  const safeMax = Math.max(SIDEBAR_MIN_WIDTH, max)
  return Math.min(safeMax, Math.max(SIDEBAR_MIN_WIDTH, width))
}

export function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH
    if (parsed === SIDEBAR_LEGACY_DEFAULT_WIDTH) return SIDEBAR_DEFAULT_WIDTH
    if (parsed === SIDEBAR_PREVIOUS_DEFAULT_WIDTH) return SIDEBAR_DEFAULT_WIDTH
    return clampSidebarWidth(parsed)
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export function saveSidebarWidth(width: number) {
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)))
}
