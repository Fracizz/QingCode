import { t, translateMessage } from '@qn/codex-client'
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
const THREAD_PREFS_KEY = 'qn-thread-model-prefs'
// 每个会话一条记录；只保留最近改动/发送过的会话，避免本地存储无限增长。
const THREAD_PREFS_LIMIT = 500

type ModelList = { models: ModelOption[]; loading: boolean; error: string | null; loadedAt?: number }

// pi 等 Agent 在会话进程启动前返回空列表（不为取列表而起进程），空列表隔一段时间允许重取。
const EMPTY_RETRY_MS = 15_000

type ModelsState = {
  /** 按 sessionKey（agent + 目标）缓存：不同目标上的 Codex 版本可能给出不同模型。 */
  lists: Record<string, ModelList>
  /**
   * 新会话（草稿）的默认偏好，按 agent 记；换目标后仍沿用同一模型（目标上没有该模型时自动回落默认）。
   * 也是还没有单独记录的旧会话的回落值。
   */
  prefs: Record<string, ModelPrefs>
  /** 已有会话各自的选择，键见 threadPrefsKey；会话之间互不影响。 */
  threadPrefs: Record<string, ModelPrefs>
  load: (targetId: string, agent: AgentKind, rpc: CodexRpcLike, force?: boolean) => Promise<void>
  /** 带 threadId 时只改该会话；不带（草稿）时改 agent 默认，作为之后新会话的初始选择。 */
  setPrefs: (agent: AgentKind, patch: Partial<ModelPrefs>, scope?: PrefsScope) => void
  /** 把发送时实际使用的选择记到会话上，之后改默认不会再影响它。 */
  rememberThreadPrefs: (targetId: string, agent: AgentKind, threadId: string, prefs: ModelPrefs) => void
  /** 打开历史会话时，本机还没有记录就用会话历史里的配置作为它的选择；已有本机选择时不覆盖。 */
  seedFromHistory: (targetId: string, agent: AgentKind, threadId: string, saved: SavedThreadConfig | undefined) => void
}

export type PrefsScope = { targetId: string; threadId: string | null }

export const threadPrefsKey = (targetId: string, agent: AgentKind, threadId: string) =>
  `${sessionKey(targetId, agent)}#${threadId}`

const readPrefs = (key: string): Record<string, ModelPrefs> => {
  try {
    return parsePrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(key))
  } catch {
    return {}
  }
}

const writePrefs = (key: string, value: Record<string, ModelPrefs>) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用只影响下次启动的默认选择。
  }
}

/** 写入并挪到末尾（最近使用），超出上限时丢弃最早的记录。 */
function putThreadPrefs(table: Record<string, ModelPrefs>, key: string, prefs: ModelPrefs): Record<string, ModelPrefs> {
  const entries = Object.entries(table).filter(([item]) => item !== key)
  entries.push([key, prefs])
  return Object.fromEntries(entries.slice(-THREAD_PREFS_LIMIT))
}

/** 当前会话生效的偏好：会话自己的记录优先，没有则用 agent 默认（历史里的配置由 seedFromHistory 先落成记录）。 */
export function prefsFor(
  state: Pick<ModelsState, 'prefs' | 'threadPrefs'>,
  targetId: string | null,
  agent: AgentKind,
  threadId: string | null,
): ModelPrefs {
  const own = targetId && threadId ? state.threadPrefs[threadPrefsKey(targetId, agent, threadId)] : undefined
  return own ?? state.prefs[agent] ?? EMPTY_PREFS
}

export type SavedThreadConfig = { model: string; effort: string | null }

/**
 * 历史回报的模型 → 选择器里的选项。精确匹配优先；Claude 历史记的是完整模型 ID（如 claude-opus-5-5），
 * 而选择器给的是别名（opus / sonnet[1m]），按去掉方括号后缀的别名被完整 ID 包含来对应，取最长的无后缀别名。
 * 对不上时返回 null，让选择器回落到默认模型，避免显示一个列表里不存在的选择。
 */
export function matchModelOption(models: readonly ModelOption[], id: string): string | null {
  if (models.some((item) => item.model === id)) return id
  const base = (value: string) => value.replace(/\[[^\]]*\]/g, '').trim().toLowerCase()
  const target = base(id)
  let best: ModelOption | undefined
  for (const item of models) {
    const alias = base(item.model)
    if (!alias || item.model === 'default' || !target.includes(alias)) continue
    const plain = item.model.toLowerCase() === alias
    const bestPlain = best ? best.model.toLowerCase() === base(best.model) : false
    if (!best || (plain && !bestPlain) || (plain === bestPlain && alias.length > base(best.model).length)) best = item
  }
  return best?.model ?? null
}

/**
 * 会话历史里的模型与强度 → 偏好；模型列表还没加载时返回 null，等列表就绪后再落记录。
 * Codex 的强度为 null 表示会话没设，沿用模型默认；Claude 历史不含强度、pi 也可能缺，缺失时沿用 agent 默认。
 * 快速档历史里没有，沿用 agent 默认。
 */
export function historyPrefs(
  state: Pick<ModelsState, 'prefs'>,
  agent: AgentKind,
  saved: SavedThreadConfig | undefined,
  models: readonly ModelOption[],
): ModelPrefs | null {
  if (!saved || models.length === 0) return null
  const base = { ...EMPTY_PREFS, ...state.prefs[agent] }
  const model = matchModelOption(models, saved.model)
  if (!model) return null
  return { ...base, model, effort: agent === 'codex' ? saved.effort : (saved.effort ?? base.effort) }
}

const samePrefs = (a: ModelPrefs | undefined, b: ModelPrefs) =>
  a !== undefined && a.model === b.model && a.effort === b.effort && a.fast === b.fast

export const useModels = create<ModelsState>((set, get) => ({
  lists: {},
  prefs: readPrefs(PREFS_KEY),
  threadPrefs: readPrefs(THREAD_PREFS_KEY),

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
      const error = err instanceof Error ? translateMessage(err.message) : t('加载模型列表失败')
      finish({ models: pending.models, loading: false, error })
    }
  },

  setPrefs: (agent, patch, scope) => {
    const state = get()
    if (scope?.threadId) {
      const key = threadPrefsKey(scope.targetId, agent, scope.threadId)
      const next = { ...EMPTY_PREFS, ...prefsFor(state, scope.targetId, agent, scope.threadId), ...patch }
      const threadPrefs = putThreadPrefs(state.threadPrefs, key, next)
      set({ threadPrefs })
      writePrefs(THREAD_PREFS_KEY, threadPrefs)
      return
    }
    const prefs = { ...state.prefs, [agent]: { ...EMPTY_PREFS, ...state.prefs[agent], ...patch } }
    set({ prefs })
    writePrefs(PREFS_KEY, prefs)
  },

  rememberThreadPrefs: (targetId, agent, threadId, prefs) => {
    const state = get()
    const key = threadPrefsKey(targetId, agent, threadId)
    if (samePrefs(state.threadPrefs[key], prefs)) return
    const threadPrefs = putThreadPrefs(state.threadPrefs, key, { ...prefs })
    set({ threadPrefs })
    writePrefs(THREAD_PREFS_KEY, threadPrefs)
  },

  seedFromHistory: (targetId, agent, threadId, saved) => {
    const state = get()
    if (state.threadPrefs[threadPrefsKey(targetId, agent, threadId)]) return
    const prefs = historyPrefs(state, agent, saved, state.lists[sessionKey(targetId, agent)]?.models ?? [])
    if (prefs) state.rememberThreadPrefs(targetId, agent, threadId, prefs)
  },
}))

/** 发送时读取当前选择对应的 turn/start 覆盖项；threadId 为 null 表示草稿（新会话）。 */
export function overridesFor(targetId: string, agent: AgentKind, threadId: string | null = null): TurnOverrides {
  const state = useModels.getState()
  const models = state.lists[sessionKey(targetId, agent)]?.models ?? []
  const prefs = prefsFor(state, targetId, agent, threadId)
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
