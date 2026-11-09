import type { TerminalTab } from '../../types'

/** 管理模式下的多选：去掉已不存在的终端，保持原选择顺序。 */
export function prunedTerminalSelection(
  selection: ReadonlySet<string>,
  terminals: ReadonlyArray<Pick<TerminalTab, 'id'>>,
): Set<string> {
  const ids = new Set(terminals.map(term => term.id))
  return new Set([...selection].filter(id => ids.has(id)))
}

export function toggleTerminalSelection(selection: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selection)
  if (!next.delete(id)) next.add(id)
  return next
}

/** 已退出的终端（等待恢复的不算：进程并没有结束）。 */
export function isEndedTerminal(term: Pick<TerminalTab, 'status' | 'awaitingRestoreSpawn'>): boolean {
  return term.status === 'exited' && !term.awaitingRestoreSpawn
}

export function allTerminalsSelected(
  selection: ReadonlySet<string>,
  terminals: ReadonlyArray<Pick<TerminalTab, 'id'>>,
): boolean {
  return terminals.length > 0 && terminals.every(term => selection.has(term.id))
}
