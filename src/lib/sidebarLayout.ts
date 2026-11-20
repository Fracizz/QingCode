export const SIDEBAR_WIDTH_KEY = 'qingcode:sidebar-width'

export const SIDEBAR_DEFAULT_WIDTH = 320
/** Old factory default — migrate so existing installs pick up the wider sidebar. */
const SIDEBAR_LEGACY_DEFAULT_WIDTH = 260
/** Previous default before 320px — migrate on load. */
const SIDEBAR_PREVIOUS_DEFAULT_WIDTH = 300
export const SIDEBAR_MIN_WIDTH = 180
/** 普通侧栏最大宽度占窗口宽度的比例。 */
export const SIDEBAR_MAX_WINDOW_RATIO = 1 / 2
/** 设置 / 源代码管理整页放进侧栏时的最大宽度比例。 */
export const SIDEBAR_PAGE_MAX_WINDOW_RATIO = 2 / 3
export const SIDEBAR_EDITOR_MIN_WIDTH = 320
/** 整页放进侧栏时的绝对下限（窄窗口兜底）。 */
export const SIDEBAR_PAGE_MIN_WIDTH = 480
export const ACTIVITY_BAR_WIDTH = 48

/**
 * 侧栏最大宽度：普通视图不超过窗口 1/2，整页视图不超过 2/3，
 * 且都至少给右侧工作区留出 SIDEBAR_EDITOR_MIN_WIDTH。
 */
export function getSidebarMaxWidth(page = false): number {
  const ratio = page ? SIDEBAR_PAGE_MAX_WINDOW_RATIO : SIDEBAR_MAX_WINDOW_RATIO
  const byRatio = Math.floor(window.innerWidth * ratio)
  const byEditor = window.innerWidth - ACTIVITY_BAR_WIDTH - SIDEBAR_EDITOR_MIN_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(byRatio, byEditor))
}

/**
 * 设置 / 源代码管理整页放进侧栏时的最小宽度：默认占工作区（窗口减活动栏）一半，
 * 可继续拖宽到侧栏上限；低于一半内容会挤成窄条。
 */
export function getSidebarPageMinWidth(): number {
  const half = Math.round((window.innerWidth - ACTIVITY_BAR_WIDTH) / 2)
  return Math.min(getSidebarMaxWidth(true), Math.max(SIDEBAR_PAGE_MIN_WIDTH, half))
}

export function getSidebarMinWidth(page = false): number {
  return page ? getSidebarPageMinWidth() : SIDEBAR_MIN_WIDTH
}

/** page 为整页视图（设置 / 源代码管理）：下限一半、上限 2/3；窗口过窄时以上限为准。 */
export function clampSidebarWidth(width: number, page = false): number {
  const max = getSidebarMaxWidth(page)
  const min = Math.min(getSidebarMinWidth(page), max)
  return Math.min(max, Math.max(min, Math.round(width)))
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
