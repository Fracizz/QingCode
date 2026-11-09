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

/** 工作台列表的选中：其他项目的终端先切项目（可能弹信任或走 SSH 连接），完成后再激活。 */
export function useTerminalProjectSelection() {
  const [pendingTerminalId, setPendingTerminalId] = useState<string | null>(null)
  const pendingRef = useRef<Pick<TerminalTab, 'id' | 'projectId'> | null>(null)

  const activate = useCallback((id: string) => {
    useTerminalStore.getState().setTerminalFocusPane('primary')
    useTerminalStore.getState().setActiveTerminal(id)
    useUIStore.getState().openTerminalPanel()
  }, [])

  const selectTerminal = useCallback(
    async (terminal: Pick<TerminalTab, 'id' | 'projectId'>) => {
      if (useProjectStore.getState().currentProject?.id === terminal.projectId) {
        pendingRef.current = null
        setPendingTerminalId(null)
        activate(terminal.id)
        return
      }
      const inFlight = pendingRef.current
      pendingRef.current = terminal
      setPendingTerminalId(terminal.id)
      // 同项目的切换已在进行：只更新目标，完成后激活最后点击的终端。
      if (inFlight?.projectId === terminal.projectId) return
      const switched = await switchToTerminalProject(terminal.projectId)
      const latest = pendingRef.current
      // 期间点了别的项目：选中状态交给那次点击。
      if (latest?.projectId !== terminal.projectId) return
      pendingRef.current = null
      setPendingTerminalId(null)
      if (switched) activate(latest.id)
    },
    [activate],
  )

  return { pendingTerminalId, selectTerminal }
}
