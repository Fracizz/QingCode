import { t, translateMessage } from '@qn/codex-client'
import { create } from 'zustand'
import { historyModelPrefs, listModels, reconcileThreadPrefs, type CodexRpcLike, type SavedThreadConfig, type TurnOverrides } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import {
  EMPTY_PREFS,
  fastTier,
  parsePrefs,
  resolveSelection,
  toModelOptions,
  turnOverrides,
  type ModelOption,
  type ModelPrefs,
} from '../lib/models'
import { modalityTable, type ModalityTable } from '../features/composer/images'

const PREFS_KEY = 'qn-model-prefs'
const THREAD_PREFS_KEY = 'qn-thread-model-prefs'
// 每个会话一条记录；只保留最近改动/发送过的会话，避免本地存储无限增长。
const THREAD_PREFS_LIMIT = 500

type ModelList = {
  models: ModelOption[]
  loading: boolean
  error: string | null
  loadedAt?: number
  startedAt?: number
  /** 同一次 model/list 结果里的输入模态（发图判断用），避免图片能力检测再单独请求一次。 */
  modalities?: ModalityTable
}

// pi 等 Agent 在会话进程启动前返回空列表（不为取列表而起进程），空列表隔一段时间允许重取。
const EMPTY_RETRY_MS = 15_000
// 强制刷新与刚发出的请求合并：同一次渲染里选择器和图片能力检测会先后触发加载。
const FORCE_MERGE_MS = 2_000

type ModelsState = {
  /** 按 sessionKey（agent + 目标）缓存：不同目标上的 Codex 版本可能给出不同模型。 */
  lists: Record<string, ModelList>
  /**
   * 新会话（草稿）的默认偏好，按 agent 记，取最后一次手动修改（不论在哪个会话改的）；
   * 换目标后仍沿用同一模型（目标上没有该模型时自动回落默认）。
   * 也是还没有单独记录的旧会话的回落值。
   */
  prefs: Record<string, ModelPrefs>
  /** 已有会话各自的选择，键见 threadPrefsKey；会话之间互不影响。 */
  threadPrefs: Record<string, ModelPrefs>
  load: (targetId: string, agent: AgentKind, rpc: CodexRpcLike, force?: boolean) => Promise<void>
  /** 丢弃缓存的列表（如配置目录切换后），下次 load 重新请求。 */
  invalidate: (targetId: string, agent: AgentKind) => void
  /** 用户手动改选：更新 agent 默认；带 threadId 时同时记到该会话，其他已记录的会话不受影响。 */
  setPrefs: (agent: AgentKind, patch: Partial<ModelPrefs>, scope?: PrefsScope) => void
  /** 把发送时实际使用的选择记到会话上，之后改默认不会再影响它。 */
  rememberThreadPrefs: (targetId: string, agent: AgentKind, threadId: string, prefs: ModelPrefs) => void
  /** 发送成功后把本轮配置记为 seen：之后历史回报的就是它，不会被当成另一端的改动。 */
  markThreadSent: (targetId: string, agent: AgentKind, threadId: string, config: { model: string; effort: string | null }) => void
  /** 打开历史会话时，本机还没有记录就用会话历史里的配置；已有记录时只在另一端换过模型后改用历史。 */
  seedFromHistory: (targetId: string, agent: AgentKind, threadId: string, saved: SavedThreadConfig | undefined) => void
}

/** saved：当前会话历史里的配置，改选时记为 seen。 */
export type PrefsScope = { targetId: string; threadId: string | null; saved?: SavedThreadConfig }

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

export type { SavedThreadConfig } from '@qn/codex-client'
export { matchModelOption } from '@qn/codex-client'

/**
 * 会话历史里的模型与强度 → 偏好；模型列表还没加载时返回 null，等列表就绪后再落记录。
 * 规则见 @qn/codex-client 的 historyModelPrefs（Codex 强度为 null 沿用模型默认，快速档按服务档位恢复）。
 */
export function historyPrefs(
  state: Pick<ModelsState, 'prefs'>,
  agent: AgentKind,
  saved: SavedThreadConfig | undefined,
  models: readonly ModelOption[],
): ModelPrefs | null {
  return historyModelPrefs(agent, models, { ...EMPTY_PREFS, ...state.prefs[agent] }, saved)
}

const samePrefs = (a: ModelPrefs | undefined, b: ModelPrefs) =>
  a !== undefined && a.model === b.model && a.effort === b.effort && a.fast === b.fast &&
  a.seen?.model === b.seen?.model && a.seen?.effort === b.seen?.effort

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
    // pi 会话刚启动时的强制刷新必须重新请求（之前的请求可能还在返回启动前的空列表）。
    if (force && agent !== 'pi' && current?.loading && Date.now() - (current.startedAt ?? 0) < FORCE_MERGE_MS) return
    const pending: ModelList = { models: current?.models ?? [], modalities: current?.modalities, loading: true, error: null, startedAt: Date.now() }
    set((state) => ({
      lists: { ...state.lists, [key]: pending },
    }))
    // 会话启动前发出的空列表请求，可能比启动后的刷新更晚返回。
    const finish = (result: ModelList) => set((state) => state.lists[key] === pending
      ? { lists: { ...state.lists, [key]: result } }
      : state)
    try {
      const raw = await listModels(rpc)
      finish({ models: toModelOptions(raw), modalities: modalityTable(raw), loading: false, error: null, loadedAt: Date.now() })
    } catch (err) {
      const error = err instanceof Error ? translateMessage(err.message) : t('加载模型列表失败')
      // 失败也记下时间并给出空模态表（按"未声明"允许发图），避免图片能力检测反复重试。
      finish({ models: pending.models, modalities: pending.modalities ?? { models: {}, defaultModel: null }, loading: false, error, loadedAt: Date.now() })
    }
  },

  invalidate: (targetId, agent) => {
    const key = sessionKey(targetId, agent)
    if (!get().lists[key]) return
    set((state) => {
      const { [key]: _removed, ...lists } = state.lists
      return { lists }
    })
  },

  setPrefs: (agent, patch, scope) => {
    const state = get()
    if (scope?.threadId) {
      const key = threadPrefsKey(scope.targetId, agent, scope.threadId)
      const next = { ...EMPTY_PREFS, ...prefsFor(state, scope.targetId, agent, scope.threadId), ...patch }
      // 记下改选时会话历史的配置；之后历史变了才说明是另一端换过模型。
      const saved = scope.saved
      if (!next.seen && saved) next.seen = { model: saved.model, effort: saved.effort }
      const threadPrefs = putThreadPrefs(state.threadPrefs, key, next)
      set({ threadPrefs })
      writePrefs(THREAD_PREFS_KEY, threadPrefs)
    }
    // 会话里改选时以该会话改完后的完整选择为默认，避免只改强度时配上默认里的另一个模型。
    const base = scope?.threadId ? prefsFor(state, scope.targetId, agent, scope.threadId) : state.prefs[agent]
    const { seen: _seen, ...defaults } = { ...EMPTY_PREFS, ...base, ...patch }
    const prefs = { ...state.prefs, [agent]: defaults }
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

  markThreadSent: (targetId, agent, threadId, config) => {
    const own = get().threadPrefs[threadPrefsKey(targetId, agent, threadId)]
    if (own) get().rememberThreadPrefs(targetId, agent, threadId, { ...own, seen: { ...config } })
  },

  seedFromHistory: (targetId, agent, threadId, saved) => {
    const state = get()
    const models = state.lists[sessionKey(targetId, agent)]?.models ?? []
    const own = state.threadPrefs[threadPrefsKey(targetId, agent, threadId)]
    // 已有本机记录时对照历史：另一端用别的模型发过消息就改用历史，否则保持本机选择。
    const prefs = own ? reconcileThreadPrefs(agent, models, own, saved) : historyPrefs(state, agent, saved, models)
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
