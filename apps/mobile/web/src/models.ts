// 模型与推理强度的纯逻辑：model/list 归一化、偏好解析、turn/start 覆盖项。移植自桌面 lib/models.ts + store/models.ts。
import { historyModelPrefs, localizeModelDescription, reconcileThreadPrefs, type SavedThreadConfig, type TurnOverrides, getLocale, t, translateMessage } from '@qn/codex-client'
import type { AgentKind } from './types'

export type ModelOption = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  efforts: { value: string; description: string }[]
  defaultEffort: string | null
  serviceTiers: { id: string; name: string; description: string }[]
  imageInput?: boolean
}

/** model 为 null 表示跟随 Agent 自身默认；fast 只对 Codex 有意义。 */
export type ModelPrefs = {
  model: string | null
  effort: string | null
  fast: boolean
  /** 只用于会话记录：写入时会话历史里的配置，用来发现另一端是否换过模型。 */
  seen?: { model: string | null; effort: string | null }
}

export const EMPTY_PREFS: ModelPrefs = { model: null, effort: null, fast: false }

export type ModelList = { models: ModelOption[]; loading: boolean; error: string | null; loadedAt?: number }

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 字段缺失的条目直接丢弃，不让坏数据进 UI。 */
export function toModelOptions(raw: unknown): ModelOption[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : []
  const options: ModelOption[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const model = text(entry.model) || text(entry.id)
    if (!model) continue
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
          .filter(isRecord)
          .map((item) => ({ value: text(item.reasoningEffort), description: text(item.description) }))
          .filter((item) => item.value)
      : []
    const serviceTiers = Array.isArray(entry.serviceTiers)
      ? entry.serviceTiers
          .filter(isRecord)
          .map((item) => ({ id: text(item.id), name: text(item.name), description: text(item.description) }))
          .filter((item) => item.id)
      : []
    options.push({
      id: text(entry.id) || model,
      model,
      displayName: text(entry.displayName) || model,
      description: text(entry.description),
      hidden: entry.hidden === true,
      isDefault: entry.isDefault === true,
      efforts,
      defaultEffort: text(entry.defaultReasoningEffort) || null,
      serviceTiers,
      ...(Array.isArray(entry.inputModalities) && entry.inputModalities.length > 0
        ? { imageInput: entry.inputModalities.includes('image') }
        : {}),
    })
  }
  return options
}

/** 当前选中的隐藏模型仍可见，避免选择结果从模型列表消失。 */
export function visibleModels(models: readonly ModelOption[], selected?: string | null, query = ''): ModelOption[] {
  const visible = models.filter((model) => !model.hidden || model.model === selected)
  const term = query.trim().toLowerCase()
  if (!term) return visible
  return visible.filter((model) =>
    [translateMessage(model.displayName), model.model, model.description, localizeModelDescription(model.description)].some((value) => value.toLowerCase().includes(term)),
  )
}

const EFFORT_LABELS: Record<string, string> = {
  // i18n-ignore: 同一原文在关闭按钮上译作 Close，这里按语言单独取值
  none: getLocale() === 'en' ? 'Off' : '关闭',
  // i18n-ignore: 同上
  off: getLocale() === 'en' ? 'Off' : '关闭',
  minimal: t('最低'),
  low: t('低'),
  medium: t('中'),
  high: t('高'),
  xhigh: t('超高'),
  max: t('极高'),
  ultra: t('极致'),
}

export { effortHint } from '@qn/codex-client'

export function effortLabel(effort: string | null | undefined): string {
  if (!effort) return ''
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** "快速"档：id/名称里带 fast/priority 的服务档位；没有就认为该模型不支持加速。 */
export function fastTier(model: ModelOption | undefined): string | null {
  if (!model) return null
  const tier = model.serviceTiers.find((item) => /fast|priority|flex-fast/i.test(`${item.id} ${item.name}`))
  return tier?.id ?? null
}

export type ResolvedSelection = {
  model: ModelOption | undefined
  effort: string | null
  fastTier: string | null
  fast: boolean
}

/** 偏好里的模型已下线时回落默认模型；强度不被支持时回落模型默认强度。 */
export function resolveSelection(models: readonly ModelOption[], prefs: ModelPrefs): ResolvedSelection {
  const model =
    (prefs.model ? models.find((item) => item.model === prefs.model) : undefined) ??
    models.find((item) => item.isDefault) ??
    models.find((item) => !item.hidden) ??
    models[0]
  const supported = model?.efforts.map((item) => item.value) ?? []
  const effort =
    prefs.effort && (supported.length === 0 || supported.includes(prefs.effort))
      ? prefs.effort
      : (model?.defaultEffort ?? supported[0] ?? null)
  const tier = fastTier(model)
  return { model, effort, fastTier: tier, fast: prefs.fast && tier !== null }
}

export function triggerLabel(selection: ResolvedSelection): string {
  if (!selection.model) return ''
  // Claude 的默认模型名由 daemon 以中文给出。
  return [translateMessage(selection.model.displayName), effortLabel(selection.effort)].filter(Boolean).join(' · ')
}

/**
 * 发送时的 turn/start 覆盖项。
 * Codex：按生效选择全部发送（含快速档）；Claude / pi：只发用户显式选过的项，且不发 serviceTier，
 * 其余沿用 Agent 自身配置。
 */
export function overridesFor(
  agent: AgentKind,
  models: readonly ModelOption[],
  prefs: ModelPrefs = EMPTY_PREFS,
): TurnOverrides {
  const selection = resolveSelection(models, prefs)
  if (!selection.model) return {}
  if (agent === 'codex') {
    return {
      model: selection.model.model,
      ...(selection.effort ? { effort: selection.effort } : {}),
      ...(selection.fastTier ? { serviceTier: selection.fast ? selection.fastTier : null } : {}),
    }
  }
  return {
    ...(prefs.model ? { model: selection.model.model } : {}),
    ...(prefs.effort && selection.effort ? { effort: selection.effort } : {}),
  }
}

/** 换模型时，旧强度若不被新模型支持就清掉，交给 resolveSelection 回落默认。 */
export function pickModel(models: readonly ModelOption[], prefs: ModelPrefs, model: string): ModelPrefs {
  const option = models.find((item) => item.model === model)
  const keepEffort = !prefs.effort || !option || option.efforts.some((item) => item.value === prefs.effort)
  return { ...prefs, model, ...(keepEffort ? {} : { effort: null }) }
}

/** 偏好表按会话键（agent + 目标）持久化；损坏数据回落为空。 */
export function parsePrefs(raw: string | null | undefined): Record<string, ModelPrefs> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return {}
    const result: Record<string, ModelPrefs> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (!isRecord(entry)) continue
      result[key] = {
        model: text(entry.model) || null,
        effort: text(entry.effort) || null,
        fast: entry.fast === true,
        ...parseSeen(entry.seen),
      }
    }
    return result
  } catch {
    return {}
  }
}

// 每个会话一条记录；只保留最近改动/发送过的会话，避免本地存储无限增长。
const THREAD_PREFS_LIMIT = 500

/** 会话自己的模型选择与 agent 默认存在同一张表里，用 `#threadId` 后缀区分。 */
export const threadPrefsKey = (sessionId: string, threadId: string) => `${sessionId}#${threadId}`

export type { SavedThreadConfig } from '@qn/codex-client'

/**
 * 当前会话生效的偏好：本机对该会话的记录（另一端用别的模型发过消息时改用历史）> 会话历史里的配置 > agent 默认。
 */
export function prefsFor(
  table: Record<string, ModelPrefs>,
  agent: AgentKind,
  sessionId: string,
  threadId: string | null,
  models: readonly ModelOption[] = [],
  saved?: SavedThreadConfig,
): ModelPrefs {
  const base = { ...EMPTY_PREFS, ...table[sessionId] }
  delete base.seen
  if (!threadId) return base
  const own = table[threadPrefsKey(sessionId, threadId)]
  if (own) return reconcileThreadPrefs(agent, models, own, saved) ?? own
  return historyModelPrefs(agent, models, base, saved) ?? base
}

/** 写入会话记录并挪到末尾（最近使用）；会话记录超出上限时丢弃最早的，agent 默认不受影响。 */
export function putThreadPrefs(table: Record<string, ModelPrefs>, key: string, prefs: ModelPrefs): Record<string, ModelPrefs> {
  const entries = Object.entries(table).filter(([item]) => item !== key)
  entries.push([key, { ...prefs }])
  const threads = entries.filter(([item]) => item.includes('#'))
  const drop = new Set(threads.slice(0, Math.max(0, threads.length - THREAD_PREFS_LIMIT)).map(([item]) => item))
  return Object.fromEntries(entries.filter(([item]) => !drop.has(item)))
}

/** 会话记录里的 seen（写入时会话历史的配置），见 @qn/codex-client 的 ThreadModelPrefs。 */
function parseSeen(value: unknown): { seen?: { model: string | null; effort: string | null } } {
  if (!isRecord(value)) return {}
  return { seen: { model: text(value.model) || null, effort: text(value.effort) || null } }
}
