export interface TerminalGridSize {
  cols: number
  rows: number
}

export const TERMINAL_ALTERNATE_PTY_DELAY_MS = 100
export const TERMINAL_NORMAL_PTY_DELAY_MS = 500

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
