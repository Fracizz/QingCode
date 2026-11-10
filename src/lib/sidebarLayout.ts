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

/**
 * 终端工作台左侧整页（Git / 设置）宽度：与普通侧栏分开保存，
 * 默认占工作区一半，至少给右侧终端留出 WORKBENCH_PAGE_TERMINAL_RESERVE。
 */
export const WORKBENCH_PAGE_WIDTH_KEY = 'qingcode:workbench-page-width'
export const WORKBENCH_PAGE_MIN_WIDTH = 480
export const WORKBENCH_PAGE_TERMINAL_RESERVE = 320

export function getWorkbenchPageMaxWidth(): number {
  const maxByWindow = window.innerWidth - ACTIVITY_BAR_WIDTH - WORKBENCH_PAGE_TERMINAL_RESERVE
  return Math.max(WORKBENCH_PAGE_MIN_WIDTH, maxByWindow)
}

export function clampWorkbenchPageWidth(width: number): number {
  return Math.min(getWorkbenchPageMaxWidth(), Math.max(WORKBENCH_PAGE_MIN_WIDTH, Math.round(width)))
}

export function getDefaultWorkbenchPageWidth(): number {
  return clampWorkbenchPageWidth((window.innerWidth - ACTIVITY_BAR_WIDTH) / 2)
}

export function loadWorkbenchPageWidth(): number {
  try {
    const raw = localStorage.getItem(WORKBENCH_PAGE_WIDTH_KEY)
    if (raw == null) return getDefaultWorkbenchPageWidth()
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return getDefaultWorkbenchPageWidth()
    return clampWorkbenchPageWidth(parsed)
  } catch {
    return getDefaultWorkbenchPageWidth()
  }
}

export function saveWorkbenchPageWidth(width: number) {
  try {
    localStorage.setItem(WORKBENCH_PAGE_WIDTH_KEY, String(clampWorkbenchPageWidth(width)))
  } catch {
    // 存储不可用时仅本次会话生效
  }
}
