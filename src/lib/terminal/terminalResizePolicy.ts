export interface TerminalGridSize {
  cols: number
  rows: number
}

export const TERMINAL_ALTERNATE_PTY_DELAY_MS = 100
export const TERMINAL_NORMAL_PTY_DELAY_MS = 500
/** 两次 SIGWINCH 的最小间隔；窗口内连续变化合并成一次，避免 TUI 逐帧整屏重排。 */
export const TERMINAL_PTY_RESIZE_LEAD_GAP_MS = 300
/**
 * 布局改网格后保持视口跟随底部的时长：覆盖合并后的 PTY 尺寸下发（≤500ms）、
 * 下发节流（300ms）与远端程序按新尺寸重绘回包（SSH 兜底 1500ms）。
 */
export const TERMINAL_RESIZE_FOLLOW_BOTTOM_MS = 2500

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

/** TUI 重绘输出安静这么久即认为整屏已画完。 */
export const TERMINAL_REDRAW_QUIET_MS = 60
/** 本地 PTY 不响应 SIGWINCH 时的兜底揭开时间。 */
export const TERMINAL_REDRAW_REVEAL_MAX_LOCAL_MS = 600
/** SSH / Server 终端要多走一次网络往返，兜底时间放宽，避免先揭开旧帧再重绘。 */
export const TERMINAL_REDRAW_REVEAL_MAX_REMOTE_MS = 1500

export function getTerminalRedrawRevealMaxMs(remote: boolean): number {
  return remote ? TERMINAL_REDRAW_REVEAL_MAX_REMOTE_MS : TERMINAL_REDRAW_REVEAL_MAX_LOCAL_MS
}

export interface TerminalRedrawRevealState {
  /** 开始发送重绘 SIGWINCH 的时间。 */
  startedAt: number
  /** 最近一次 PTY 输出解析完成的时间。 */
  lastOutputAt: number
  now: number
  maxMs: number
  quietMs?: number
}

/**
 * 重挂后的重绘遮罩何时揭开。
 *
 * 必须先收到重绘开始之后的输出（即 TUI 对 SIGWINCH 的回包），再等输出安静；
 * 仅凭「安静」判断时，回包慢于安静窗口（SSH 常见）会把旧帧先揭开再整屏重画。
 * 程序始终不回包时按 maxMs 兜底。
 */
export function shouldRevealTerminalAfterRedraw({
  startedAt,
  lastOutputAt,
  now,
  maxMs,
  quietMs = TERMINAL_REDRAW_QUIET_MS,
}: TerminalRedrawRevealState): boolean {
  if (now - startedAt >= maxMs) return true
  return lastOutputAt >= startedAt && now - lastOutputAt >= quietMs
}
