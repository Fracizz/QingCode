export interface TerminalGridSize {
  cols: number
  rows: number
}

export const TERMINAL_ALTERNATE_PTY_DELAY_MS = 100
export const TERMINAL_NORMAL_PTY_DELAY_MS = 500
/** 两次 SIGWINCH 的最小间隔；窗口内连续变化合并成一次，避免 TUI 逐帧整屏重排。 */
export const TERMINAL_PTY_RESIZE_LEAD_GAP_MS = 300

export function isValidTerminalGridSize(size: TerminalGridSize | undefined): size is TerminalGridSize {
  return Boolean(
    size &&
      Number.isFinite(size.cols) &&
      Number.isFinite(size.rows) &&
      size.cols >= 2 &&
      size.rows >= 1,
  )
}

export function terminalGridSizeChanged(
  current: TerminalGridSize,
  next: TerminalGridSize,
): boolean {
  return current.cols !== next.cols || current.rows !== next.rows
}

/** ConPTY 全屏程序更需要及时响应，普通缓冲区则优先合并整屏刷新。 */
export function getTerminalPtyResizeDelay(bufferType: 'normal' | 'alternate'): number {
  return bufferType === 'alternate'
    ? TERMINAL_ALTERNATE_PTY_DELAY_MS
    : TERMINAL_NORMAL_PTY_DELAY_MS
}

/**
 * 是否可以把这次尺寸立即交给 PTY。
 *
 * 启动阶段字体加载、面板 settle、窗口缩放会连着产生多次网格变化，而每次
 * SIGWINCH 都会让 TUI 整屏重排。Claude Code 一类 inline 渲染器还会把每次重排
 * 追加进 scrollback（anthropics/claude-code#46834、#49086），于是出现「banner
 * 刷满一屏」。所以只保证窗口内第一次变化立即提交，其余合并。
 */
export function shouldSendPtyResizeNow(
  lastSentAt: number,
  now: number,
  gapMs: number = TERMINAL_PTY_RESIZE_LEAD_GAP_MS,
): boolean {
  if (!Number.isFinite(lastSentAt) || lastSentAt <= 0) return true
  if (!Number.isFinite(now)) return true
  return now - lastSentAt >= gapMs
}
