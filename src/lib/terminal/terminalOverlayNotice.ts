/**
 * 终端连接状态提示（断线、重连、已接回）。
 *
 * 这些提示不能写进终端数据流：前台常驻 TUI（Claude Code、OpenCode 等）时，
 * 光标停在 TUI 布局内部，插入 `\r\n[提示]\r\n` 会盖住界面、滚动整屏，
 * 还会打乱 TUI 按行数擦除重绘的假设，直到下次整屏重绘才恢复。
 * 改为由终端视图以浮层显示，不触碰 xterm 缓冲。
 */

export type TerminalOverlayNotice = {
  text: string
  /** 常驻直到被替换或清除（例如重连中）；否则显示一段时间后自动消失。 */
  sticky: boolean
  /** 单调递增的序号，视图据此区分「同文本的新提示」。 */
  serial: number
  at: number
}

type Listener = (notice: TerminalOverlayNotice | null) => void

/** 非常驻提示的显示时长。 */
export const TERMINAL_OVERLAY_NOTICE_MS = 4_000

const latestNotices = new Map<string, TerminalOverlayNotice>()
const listeners = new Map<string, Set<Listener>>()
let nextSerial = 1

function emit(id: string, notice: TerminalOverlayNotice | null) {
  for (const listener of listeners.get(id) ?? []) listener(notice)
}

export function publishTerminalOverlayNotice(
  id: string,
  text: string,
  options: { sticky?: boolean; now?: number } = {},
): TerminalOverlayNotice {
  const notice: TerminalOverlayNotice = {
    text,
    sticky: options.sticky === true,
    serial: nextSerial++,
    at: options.now ?? Date.now(),
  }
  latestNotices.set(id, notice)
  emit(id, notice)
  return notice
}

export function clearTerminalOverlayNotice(id: string) {
  if (!latestNotices.delete(id)) return
  emit(id, null)
}

/** 当前仍应显示的提示：常驻提示，或尚未过期的临时提示。 */
export function activeTerminalOverlayNotice(
  id: string,
  now = Date.now(),
): TerminalOverlayNotice | null {
  const notice = latestNotices.get(id)
  if (!notice) return null
  if (notice.sticky || now - notice.at < TERMINAL_OVERLAY_NOTICE_MS) return notice
  latestNotices.delete(id)
  return null
}

/**
 * 订阅某个终端的提示；视图挂载晚于提示发布时，立即补发仍有效的那条。
 * 返回取消订阅函数。
 */
export function subscribeTerminalOverlayNotice(id: string, listener: Listener): () => void {
  const set = listeners.get(id) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(id, set)
  const current = activeTerminalOverlayNotice(id)
  if (current) listener(current)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(id)
  }
}
