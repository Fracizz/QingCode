/**
 * 双终端 / 田字布局的窗格归属与绑定：哪个终端属于哪个窗格、关闭终端后各窗格改绑谁，
 * 以及同项目内的标签重排。均为作用于 state 片段的函数，不持有模块级状态。
 * 从 terminalStore 拆出，对外 API 仍由 terminalStore 统一重新导出。
 */
import type { TerminalTab } from '../../types'
import { useUIStore } from '../uiStore'

/** Dual: primary|secondary. 田: primary=TL, secondary=TR, bl=BL, br=BR. */
export type TerminalFocusPane = 'primary' | 'secondary' | 'bl' | 'br'

export const TERMINAL_FOCUS_PANES: readonly TerminalFocusPane[] = [
  'primary',
  'secondary',
  'bl',
  'br',
] as const


/** Pane that owns a session; legacy tabs without `pane` belong to primary. */
export function terminalPaneOf(tab: Pick<TerminalTab, 'pane'>): TerminalFocusPane {
  // 只显示一个窗格时（经典、单终端、工作台），标签栏或列表里的终端全部按主窗格处理；
  // 不改写 tab.pane，切回双/四终端后各终端回到原窗格。
  const { panelLayout, sideDualTerminal, sideQuadTerminal } = useUIStore.getState()
  const multiPane = panelLayout === 'sideTerminal' && (sideDualTerminal || sideQuadTerminal)
  return multiPane ? (tab.pane ?? 'primary') : 'primary'
}

/** Infer missing `pane` ownership from dual/田 active bindings (legacy shared pool). */
export function inferTerminalPaneOwnership(
  terminals: TerminalTab[],
  bindings: {
    activeTerminalByProject: Record<string, string>
    secondaryTerminalByProject?: Record<string, string>
    blTerminalByProject?: Record<string, string>
    brTerminalByProject?: Record<string, string>
  },
): TerminalTab[] {
  const owner = new Map<string, TerminalFocusPane>()
  for (const id of Object.values(bindings.activeTerminalByProject)) {
    owner.set(id, 'primary')
  }
  for (const id of Object.values(bindings.secondaryTerminalByProject ?? {})) {
    owner.set(id, 'secondary')
  }
  for (const id of Object.values(bindings.blTerminalByProject ?? {})) {
    owner.set(id, 'bl')
  }
  for (const id of Object.values(bindings.brTerminalByProject ?? {})) {
    owner.set(id, 'br')
  }
  let changed = false
  const next = terminals.map(tab => {
    if (tab.pane) return tab
    changed = true
    return { ...tab, pane: owner.get(tab.id) ?? 'primary' }
  })
  return changed ? next : terminals
}

export type TerminalDropPosition = 'before' | 'after'

/** Move one terminal beside another while preserving every unrelated tab's order. */
export function reorderTerminalTabs(
  terminals: TerminalTab[],
  sourceId: string,
  targetId: string,
  position: TerminalDropPosition,
): TerminalTab[] {
  if (sourceId === targetId) return terminals
  const source = terminals.find(tab => tab.id === sourceId)
  const target = terminals.find(tab => tab.id === targetId)
  if (!source || !target || source.projectId !== target.projectId) return terminals

  const next = terminals.filter(tab => tab.id !== sourceId)
  const targetIndex = next.findIndex(tab => tab.id === targetId)
  if (targetIndex < 0) return terminals
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, source)
  return next.every((tab, index) => tab === terminals[index]) ? terminals : next
}

export type PaneBindingSlice = {
  activeTerminalId: string | null
  secondaryTerminalId: string | null
  blTerminalId: string | null
  brTerminalId: string | null
  activeTerminalByProject: Record<string, string>
  secondaryTerminalByProject: Record<string, string>
  blTerminalByProject: Record<string, string>
  brTerminalByProject: Record<string, string>
}

export function readPaneTerminalId(s: PaneBindingSlice, pane: TerminalFocusPane): string | null {
  switch (pane) {
    case 'primary':
      return s.activeTerminalId
    case 'secondary':
      return s.secondaryTerminalId
    case 'bl':
      return s.blTerminalId
    case 'br':
      return s.brTerminalId
  }
}

/** Assign `id` as the active session for `pane` (no cross-pane steal/swap). */
export function bindTerminalToPane(
  s: PaneBindingSlice,
  projectId: string,
  pane: TerminalFocusPane,
  id: string
): Partial<PaneBindingSlice> {
  const next: PaneBindingSlice = {
    activeTerminalId: s.activeTerminalId,
    secondaryTerminalId: s.secondaryTerminalId,
    blTerminalId: s.blTerminalId,
    brTerminalId: s.brTerminalId,
    activeTerminalByProject: { ...s.activeTerminalByProject },
    secondaryTerminalByProject: { ...s.secondaryTerminalByProject },
    blTerminalByProject: { ...s.blTerminalByProject },
    brTerminalByProject: { ...s.brTerminalByProject },
  }

  const writePane = (target: TerminalFocusPane, terminalId: string | null) => {
    switch (target) {
      case 'primary':
        next.activeTerminalId = terminalId
        if (terminalId) next.activeTerminalByProject[projectId] = terminalId
        else delete next.activeTerminalByProject[projectId]
        break
      case 'secondary':
        next.secondaryTerminalId = terminalId
        if (terminalId) next.secondaryTerminalByProject[projectId] = terminalId
        else delete next.secondaryTerminalByProject[projectId]
        break
      case 'bl':
        next.blTerminalId = terminalId
        if (terminalId) next.blTerminalByProject[projectId] = terminalId
        else delete next.blTerminalByProject[projectId]
        break
      case 'br':
        next.brTerminalId = terminalId
        if (terminalId) next.brTerminalByProject[projectId] = terminalId
        else delete next.brTerminalByProject[projectId]
        break
    }
  }

  // Clear stale bindings if this id was incorrectly pointed at from another pane.
  for (const p of TERMINAL_FOCUS_PANES) {
    if (p === pane) continue
    if (readPaneTerminalId(s, p) === id) writePane(p, null)
  }
  writePane(pane, id)
  return next
}

export function clearClosedFromPanes(
  s: PaneBindingSlice,
  projectId: string,
  closedId: string,
  remaining: TerminalTab[],
): Partial<PaneBindingSlice> {
  const pickForPane = (pane: TerminalFocusPane) => {
    for (const tab of remaining) {
      if (tab.projectId !== projectId) continue
      if (terminalPaneOf(tab) !== pane) continue
      if (tab.id === closedId) continue
      return tab.id
    }
    return null
  }

  let activeTerminalId = s.activeTerminalId
  let secondaryTerminalId = s.secondaryTerminalId
  let blTerminalId = s.blTerminalId
  let brTerminalId = s.brTerminalId
  const activeTerminalByProject = { ...s.activeTerminalByProject }
  const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
  const blTerminalByProject = { ...s.blTerminalByProject }
  const brTerminalByProject = { ...s.brTerminalByProject }

  if (activeTerminalId === closedId) {
    activeTerminalId = pickForPane('primary')
    if (activeTerminalId) activeTerminalByProject[projectId] = activeTerminalId
    else delete activeTerminalByProject[projectId]
  }

  if (secondaryTerminalId === closedId) {
    secondaryTerminalId = pickForPane('secondary')
    if (secondaryTerminalId) secondaryTerminalByProject[projectId] = secondaryTerminalId
    else delete secondaryTerminalByProject[projectId]
  }

  if (blTerminalId === closedId) {
    blTerminalId = pickForPane('bl')
    if (blTerminalId) blTerminalByProject[projectId] = blTerminalId
    else delete blTerminalByProject[projectId]
  }

  if (brTerminalId === closedId) {
    brTerminalId = pickForPane('br')
    if (brTerminalId) brTerminalByProject[projectId] = brTerminalId
    else delete brTerminalByProject[projectId]
  }

  return {
    activeTerminalId,
    secondaryTerminalId,
    blTerminalId,
    brTerminalId,
    activeTerminalByProject,
    secondaryTerminalByProject,
    blTerminalByProject,
    brTerminalByProject,
  }
}

export function clearProjectPaneMaps(
  s: PaneBindingSlice,
  projectId: string,
  closedIds: string[]
): Partial<PaneBindingSlice> {
  const activeTerminalByProject = { ...s.activeTerminalByProject }
  const secondaryTerminalByProject = { ...s.secondaryTerminalByProject }
  const blTerminalByProject = { ...s.blTerminalByProject }
  const brTerminalByProject = { ...s.brTerminalByProject }
  delete activeTerminalByProject[projectId]
  delete secondaryTerminalByProject[projectId]
  delete blTerminalByProject[projectId]
  delete brTerminalByProject[projectId]
  return {
    activeTerminalId: closedIds.includes(s.activeTerminalId ?? '') ? null : s.activeTerminalId,
    secondaryTerminalId: closedIds.includes(s.secondaryTerminalId ?? '')
      ? null
      : s.secondaryTerminalId,
    blTerminalId: closedIds.includes(s.blTerminalId ?? '') ? null : s.blTerminalId,
    brTerminalId: closedIds.includes(s.brTerminalId ?? '') ? null : s.brTerminalId,
    activeTerminalByProject,
    secondaryTerminalByProject,
    blTerminalByProject,
    brTerminalByProject,
  }
}
