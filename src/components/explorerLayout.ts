/** Panel title + project root (资源管理器 / 项目名). */
export const EXPLORER_HEADING_INSET = 'pl-4'
export const EXPLORER_HEADING_ROW = 'flex h-9 shrink-0 items-center'
export const EXPLORER_HEADING_GRID = 'grid grid-cols-[15px_minmax(0,1fr)] items-center gap-x-2'
export const EXPLORER_HEADING_ICON = 'size-[15px] shrink-0 text-brand'
export const EXPLORER_HEADING_LABEL = 'truncate leading-tight'

/**
 * File tree row columns — keep in sync with ExplorerTreeRow (`paddingLeft: depth * 12 + 8`).
 * Project children start at depth 1 (see flattenVisibleNodes).
 */
export const EXPLORER_TREE_CHEVRON_COL =
  'flex w-[14px] shrink-0 items-center justify-center text-fg-dim'
export const EXPLORER_TREE_ROW = 'flex items-center gap-1'
export const EXPLORER_TREE_NODE_ROW =
  'flex w-full items-center gap-1 pr-2 py-[3px] text-[13px] select-none'
/** depth 1 → 20px — siblings of .agents / .git under the project root */
export const EXPLORER_TREE_DEPTH1_PL = 'pl-5'
/** depth 2 → 32px — children nested under 收藏夹 */
export const EXPLORER_TREE_DEPTH2_PL = 'pl-8'

/** VS Code-style collapsible subsection (收藏夹). */
export const EXPLORER_SUBSECTION_HEADER =
  'flex h-7 w-full items-center gap-1.5 pr-1 text-[11px] font-semibold tracking-wide text-fg-muted select-none transition-colors hover:text-fg'
/** Inset card — clearer block, soft rounded border + shadow. */
export const EXPLORER_FAVORITES_SECTION =
  'mx-2.5 mb-2 mt-1.5 flex-shrink-0 overflow-hidden rounded-md border border-border-strong/45 bg-[color-mix(in_srgb,color-mix(in_srgb,var(--color-bg-elevated)_72%,var(--color-bg-active)),var(--color-bg-sidebar)_28%)] shadow-[0_1px_5px_color-mix(in_srgb,#000_16%,transparent)]'
export const EXPLORER_FAVORITES_INSET = 'px-2.5'
/** Item indent inside the card (~aligns with tree depth 2). */
export const EXPLORER_FAVORITES_ITEM_PL = 'pl-5'
export const EXPLORER_FAVORITES_ITEM_ROW = `${EXPLORER_TREE_NODE_ROW} items-start rounded-sm py-1 pr-2`
/** Fixed slot so remove control never overlaps truncated labels. */
export const EXPLORER_FAVORITES_ACTION_COL = 'flex w-[18px] shrink-0 items-center justify-center'

export function explorerTreePaddingPx(depth: number): number {
  return depth * 12 + 8
}
