/** Default PTY grid when the host size is not yet known. */
export const DEFAULT_PTY_COLS = 80
export const DEFAULT_PTY_ROWS = 24

/**
 * Clamp xterm / ConPTY dimensions to portable-pty safe bounds.
 * Invalid or zero values fall back to the defaults.
 */
export function normalizePtySize(cols: number, rows: number): { cols: number; rows: number } {
  const nextCols = Number.isFinite(cols) ? Math.floor(cols) : DEFAULT_PTY_COLS
  const nextRows = Number.isFinite(rows) ? Math.floor(rows) : DEFAULT_PTY_ROWS
  return {
    cols: Math.min(1000, Math.max(2, nextCols > 0 ? nextCols : DEFAULT_PTY_COLS)),
    rows: Math.min(500, Math.max(1, nextRows > 0 ? nextRows : DEFAULT_PTY_ROWS)),
  }
}
