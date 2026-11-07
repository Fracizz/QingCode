/** 终端右键菜单的项编排：纯函数，按选区/可写/AI CLI 状态隐藏不可用项而非灰显。 */

export type TerminalContextMenuItemId =
  | 'copy'
  | 'quote'
  | 'paste'
  | 'selectAll'
  | 'composer'
  | 'find'
  | 'export'
  | 'clear'

export interface TerminalContextMenuState {
  /** 右键时捕获到的选区是否非空。 */
  hasSelection: boolean
  /** 选区能否引用到 AI CLI（需非空且程序开启 bracketed paste）。 */
  canQuote: boolean
  /** 终端是否可写（只读/已退出时隐藏写入类操作）。 */
  writable: boolean
}

export interface TerminalContextMenuEntry {
  id: TerminalContextMenuItemId
  separatorBefore?: boolean
}

export function terminalContextMenuEntries(state: TerminalContextMenuState): TerminalContextMenuEntry[] {
  const { hasSelection, canQuote, writable } = state
  const groups: TerminalContextMenuItemId[][] = [
    hasSelection
      ? ['copy', ...(canQuote && writable ? ['quote' as const] : []), ...(writable ? ['paste' as const] : [])]
      : [...(writable ? ['paste' as const] : []), 'selectAll', ...(writable ? ['composer' as const] : [])],
    ['find'],
    ['export', 'clear'],
  ]
  const entries: TerminalContextMenuEntry[] = []
  for (const group of groups) {
    group.forEach((id, index) => {
      entries.push(index === 0 && entries.length > 0 ? { id, separatorBefore: true } : { id })
    })
  }
  return entries
}
