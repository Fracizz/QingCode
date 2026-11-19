/**
 * 终端右键菜单的项编排：纯函数，按选区/可写状态隐藏不可用项。
 * 例外：「添加到对话」在程序未开启 bracketed paste 时灰显并附说明，避免菜单项时有时无。
 */

export type TerminalContextMenuItemId =
  | 'copy'
  | 'quote'
  | 'paste'
  | 'selectAll'
  | 'composer'
  | 'clearInput'
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
  disabled?: boolean
}

export function terminalContextMenuEntries(state: TerminalContextMenuState): TerminalContextMenuEntry[] {
  const { hasSelection, canQuote, writable } = state
  const groups: TerminalContextMenuItemId[][] = [
    hasSelection
      ? ['copy', ...(writable ? (['quote', 'composer', 'paste'] as const) : [])]
      : [...(writable ? ['paste' as const] : []), 'selectAll', ...(writable ? ['composer' as const] : [])],
    ['find'],
    ['export', ...(writable ? ['clearInput' as const] : []), 'clear'],
  ]
  const entries: TerminalContextMenuEntry[] = []
  for (const group of groups) {
    group.forEach((id, index) => {
      const entry: TerminalContextMenuEntry = { id }
      if (index === 0 && entries.length > 0) entry.separatorBefore = true
      if (id === 'quote' && !canQuote) entry.disabled = true
      entries.push(entry)
    })
  }
  return entries
}

/** 把终端选中文字追加进长文本草稿：草稿为空直接用选区，否则另起一行。 */
export function appendComposerDraft(draft: string, selection: string): string {
  if (!selection) return draft
  if (!draft) return selection
  return draft.endsWith('\n') ? draft + selection : `${draft}\n${selection}`
}
