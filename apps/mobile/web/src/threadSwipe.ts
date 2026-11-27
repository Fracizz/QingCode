export const ARCHIVE_ACTION_WIDTH = 84

export function threadSwipeAxis(dx: number, dy: number): 'horizontal' | 'vertical' | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return null
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
}

export function threadSwipeOffset(revealed: boolean, dx: number): number {
  const start = revealed ? -ARCHIVE_ACTION_WIDTH : 0
  return Math.max(-ARCHIVE_ACTION_WIDTH, Math.min(0, start + dx))
}
