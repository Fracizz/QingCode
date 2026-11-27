// 外壳布局的尺寸约束与偏好解析（纯逻辑）。

export const TITLEBAR_HEIGHT = 38
export const SIDEBAR_DEFAULT_WIDTH = 288
export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 460
/** 主对话区至少保留的宽度，侧栏再宽也不能把对话挤没。 */
export const MAIN_MIN_WIDTH = 480
export const SIDE_CHAT_DEFAULT_WIDTH = 540
const SIDE_CHAT_MIN_WIDTH = 320
const SIDE_CHAT_MAX_WIDTH = 720

export function sideChatLayout(preferredWidth: number, availableWidth: number) {
  const docked = availableWidth >= MAIN_MIN_WIDTH + SIDE_CHAT_MIN_WIDTH
  const remaining = availableWidth - (docked ? MAIN_MIN_WIDTH : 48)
  const max = Math.max(0, Math.min(SIDE_CHAT_MAX_WIDTH, remaining))
  const min = Math.min(SIDE_CHAT_MIN_WIDTH, max)
  const width = Math.min(max, Math.max(min, preferredWidth))
  return { docked, min, max, width }
}

export type ChatWidth = 'default' | 'wide'

export type LayoutPrefs = {
  sidebarWidth: number
  sidebarCollapsed: boolean
  chatWidth: ChatWidth
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  chatWidth: 'default',
}

export function clampSidebarWidth(width: number, windowWidth?: number): number {
  const limit =
    windowWidth && Number.isFinite(windowWidth)
      ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, windowWidth - MAIN_MIN_WIDTH))
      : SIDEBAR_MAX_WIDTH
  if (!Number.isFinite(width)) return Math.min(SIDEBAR_DEFAULT_WIDTH, limit)
  return Math.round(Math.min(limit, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

/** localStorage 里的旧值或损坏值都回落到默认，不让布局卡在异常状态。 */
export function parseLayoutPrefs(raw: string | null | undefined): LayoutPrefs {
  if (!raw) return { ...DEFAULT_LAYOUT }
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof LayoutPrefs, unknown>>
    return {
      sidebarWidth: clampSidebarWidth(
        typeof value.sidebarWidth === 'number' ? value.sidebarWidth : SIDEBAR_DEFAULT_WIDTH,
      ),
      sidebarCollapsed: value.sidebarCollapsed === true,
      chatWidth: value.chatWidth === 'wide' ? 'wide' : DEFAULT_LAYOUT.chatWidth,
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

/** 系统窗口按钮所在侧：Windows/Linux 在右，macOS 在左（红绿灯）。 */
export function windowControlsSide(platform: string | undefined): 'left' | 'right' {
  return platform === 'darwin' ? 'left' : 'right'
}
