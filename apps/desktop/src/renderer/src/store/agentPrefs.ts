import { create } from 'zustand'
import type { AgentKind } from '../../../shared/backendApi'
import { parseDefaultAgents } from '../lib/agents'

const PREFS_KEY = 'qn-default-agents'

type AgentPrefsState = {
  /** targetId → 该连接新会话默认使用的 Agent。 */
  byTarget: Record<string, AgentKind>
  /** 传 null 表示取消默认，回到自动选择。 */
  setDefault: (targetId: string, agent: AgentKind | null) => void
}

const read = (): Record<string, AgentKind> => {
  try {
    return parseDefaultAgents(typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY))
  } catch {
    return {}
  }
}

export const useAgentPrefs = create<AgentPrefsState>((set, get) => ({
  byTarget: read(),
  setDefault: (targetId, agent) => {
    const byTarget = { ...get().byTarget }
    if (agent) byTarget[targetId] = agent
    else delete byTarget[targetId]
    set({ byTarget })
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(byTarget))
    } catch {
      // 存储不可用时只影响下次启动。
    }
  },
}))
