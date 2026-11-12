import { useCallback, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import type { Project, TerminalTab } from '../types'

/** 切到指定项目；项目已不在列表或切换未完成（信任被拒、SSH 失败、被新点击取代）时返回 null。 */
export async function switchToTerminalProject(projectId: string): Promise<Project | null> {
  const state = useProjectStore.getState()
  if (state.currentProject?.id === projectId) return state.currentProject
  const project = state.projects.find(candidate => candidate.id === projectId)
  if (!project) return null
  return (await state.switchProject(project)) ? useProjectStore.getState().currentProject : null
}

type Selection = { projectId: string; terminalId: string | null }

/** 项目菜单与终端行共用切换目标；完成信任和 SSH 流程后，只激活最后选择的终端。 */
export function useTerminalProjectSelection() {
  const [pending, setPending] = useState<Selection | null>(null)
  const pendingRef = useRef<Selection | null>(null)

  const activate = useCallback((id: string) => {
    useTerminalStore.getState().setTerminalFocusPane('primary')
    useTerminalStore.getState().setActiveTerminal(id)
    useUIStore.getState().openTerminalPanel()
  }, [])

  const select = useCallback(
    async (selection: Selection) => {
      const state = useProjectStore.getState()
      const inFlight = pendingRef.current
      if (state.currentProject?.id === selection.projectId && !inFlight) {
        if (selection.terminalId) activate(selection.terminalId)
        return
      }
      pendingRef.current = selection
      setPending(selection)
      // 同项目的切换已在进行：只更新目标，避免重复连接。
      if (inFlight?.projectId === selection.projectId) return
      // 点回当前项目也要让 store 取代在途切换，避免迟到的 SSH 结果切走工作区。
      const switched = state.currentProject?.id === selection.projectId
        ? await state.switchProject(state.currentProject)
        : await switchToTerminalProject(selection.projectId)
      const latest = pendingRef.current
      // 期间点了别的项目：选中状态交给那次点击。
      if (latest?.projectId !== selection.projectId) return
      pendingRef.current = null
      setPending(null)
      if (switched && latest.terminalId) activate(latest.terminalId)
    },
    [activate],
  )

  const selectTerminal = useCallback(
    (terminal: Pick<TerminalTab, 'id' | 'projectId'>) =>
      select({ projectId: terminal.projectId, terminalId: terminal.id }),
    [select],
  )
  const selectProject = useCallback(
    (projectId: string) => select({ projectId, terminalId: null }),
    [select],
  )

  return {
    pendingTerminalId: pending?.terminalId ?? null,
    pendingProjectId: pending?.projectId ?? null,
    selectTerminal,
    selectProject,
  }
}
