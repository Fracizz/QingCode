import { create } from 'zustand'
import { listModels, type CodexRpcLike, type TurnOverrides } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import {
  EMPTY_PREFS,
  parsePrefs,
  resolveSelection,
  toModelOptions,
  turnOverrides,
  type ModelOption,
  type ModelPrefs,
} from '../lib/models'

const PREFS_KEY = 'qn-model-prefs'

type ModelList = { models: ModelOption[]; loading: boolean; error: string | null; loadedAt?: number }

// pi 等 Agent 在会话进程启动前返回空列表（不为取列表而起进程），空列表隔一段时间允许重取。
const EMPTY_RETRY_MS = 15_000

type ModelsState = {
  /** 按 sessionKey（agent + 目标）缓存：不同目标上的 Codex 版本可能给出不同模型。 */
  lists: Record<string, ModelList>
  /** 偏好按 agent 记，换目标后仍沿用同一模型（目标上没有该模型时自动回落默认）。 */
  prefs: Record<string, ModelPrefs>
  load: (targetId: string, agent: AgentKind, rpc: CodexRpcLike, force?: boolean) => Promise<void>
  setPrefs: (agent: AgentKind, patch: Partial<ModelPrefs>) => void
}

const readPrefs = (): Record<string, ModelPrefs> => {
  try {
    return parsePrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(PREFS_KEY))
  } catch {
    return {}
  }
}

export const useModels = create<ModelsState>((set, get) => ({
  lists: {},
  prefs: readPrefs(),

  load: async (targetId, agent, rpc, force = false) => {
    const key = sessionKey(targetId, agent)
    const current = get().lists[key]
    const staleEmpty =
      current !== undefined && current.models.length === 0 && Date.now() - (current.loadedAt ?? 0) > EMPTY_RETRY_MS
    if (!force && (current?.loading || (current && !current.error && !staleEmpty))) return
    const pending: ModelList = { models: current?.models ?? [], loading: true, error: null }
    set((state) => ({
      lists: { ...state.lists, [key]: pending },
    }))
    // 会话启动前发出的空列表请求，可能比启动后的刷新更晚返回。
    const finish = (result: ModelList) => set((state) => state.lists[key] === pending
      ? { lists: { ...state.lists, [key]: result } }
      : state)
    try {
      const models = toModelOptions(await listModels(rpc))
      finish({ models, loading: false, error: null, loadedAt: Date.now() })
    } catch (err) {
      const error = err instanceof Error ? err.message : '加载模型列表失败'
      finish({ models: pending.models, loading: false, error })
    }
  },

  setPrefs: (agent, patch) => {
    const prefs = { ...get().prefs, [agent]: { ...EMPTY_PREFS, ...get().prefs[agent], ...patch } }
    set({ prefs })
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // 存储不可用只影响下次启动的默认选择。
    }
  },
}))

/** 发送时读取当前选择对应的 turn/start 覆盖项。 */
export function overridesFor(targetId: string, agent: AgentKind): TurnOverrides {
  const state = useModels.getState()
  const models = state.lists[sessionKey(targetId, agent)]?.models ?? []
  const prefs = state.prefs[agent] ?? EMPTY_PREFS
  const overrides = turnOverrides(resolveSelection(models, prefs))
  if (agent === 'codex') return overrides
  // Claude / pi：用户没主动选过的项不发，沿用 Agent 自身配置（如 Claude settings 里的默认模型与强度）。
  const { model, effort, ...rest } = overrides
  return {
    ...rest,
    ...(prefs.model && model ? { model } : {}),
    ...(prefs.effort && effort ? { effort } : {}),
  }
}
