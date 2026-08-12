/** Panel title + project root (资源管理器 / 项目名). */
export const EXPLORER_HEADING_INSET = 'pl-4'
export const EXPLORER_HEADING_GRID = 'grid grid-cols-[15px_minmax(0,1fr)] items-center gap-x-2'
export const EXPLORER_HEADING_ICON = 'size-[15px] shrink-0 text-brand'

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

export function explorerTreePaddingPx(depth: number): number {
  return depth * 12 + 8
}
