export interface TerminalGridSize {
  cols: number
  rows: number
}

/** 长缓冲区横向 resize 会重排历史行，因此只合并列数变化。 */
export const TERMINAL_LONG_BUFFER_THRESHOLD = 200
export const TERMINAL_COLUMN_RESIZE_DELAY_MS = 100
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

export function shouldDeferTerminalColumns(
  normalBufferLength: number,
  current: TerminalGridSize,
  next: TerminalGridSize,
): boolean {
  return (
    normalBufferLength >= TERMINAL_LONG_BUFFER_THRESHOLD && current.cols !== next.cols
  )
}

/** ConPTY 全屏程序更需要及时响应，普通缓冲区则优先合并整屏刷新。 */
export function getTerminalPtyResizeDelay(bufferType: 'normal' | 'alternate'): number {
  return bufferType === 'alternate'
    ? TERMINAL_ALTERNATE_PTY_DELAY_MS
    : TERMINAL_NORMAL_PTY_DELAY_MS
}
