/** Hard cap on simultaneously open editor tabs (per project session). */
export const MAX_OPEN_EDITOR_TABS = 20

/** Width reserved for the overflow / “all tabs” chevron. */
export const EDITOR_TAB_OVERFLOW_BTN_W = 32

/**
 * Contiguous visible tab indices that always include `activeIndex`, filling
 * left then right within `available` width (overflow button already reserved).
 */
export function pickVisibleTabIndices(
  widths: readonly number[],
  activeIndex: number,
  available: number,
  overflowBtnWidth = EDITOR_TAB_OVERFLOW_BTN_W,
): number[] {
  const n = widths.length
  if (n === 0) return []

  const budget = Math.max(0, available - overflowBtnWidth)
  const active = Math.min(Math.max(0, activeIndex), n - 1)
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (total <= budget) {
    return Array.from({ length: n }, (_, i) => i)
  }

  let start = active
  let end = active + 1
  let used = widths[active] ?? 0
  if (used > budget) return [active]

  while (start > 0 && used + (widths[start - 1] ?? 0) <= budget) {
    start -= 1
    used += widths[start] ?? 0
  }
  while (end < n && used + (widths[end] ?? 0) <= budget) {
    used += widths[end] ?? 0
    end += 1
  }

  return Array.from({ length: end - start }, (_, i) => start + i)
}

/** Prefer closing the least-recent clean tab; never auto-close dirty/pinned. */
export function pickEvictableTabId(
  tabs: ReadonlyArray<{ id: string; dirty?: boolean; path: string }>,
  tabMru: readonly string[],
  isPinned: (path: string) => boolean,
  protectId?: string | null,
): string | null {
  const ids = tabMru.filter(id => tabs.some(tab => tab.id === id))
  const ordered = [...ids].reverse()
  for (const id of ordered) {
    if (protectId && id === protectId) continue
    const tab = tabs.find(candidate => candidate.id === id)
    if (!tab || tab.dirty || isPinned(tab.path)) continue
    return id
  }
  return null
}
