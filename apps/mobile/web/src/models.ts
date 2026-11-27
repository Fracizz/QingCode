// 模型与推理强度的纯逻辑：model/list 归一化、偏好解析、turn/start 覆盖项。移植自桌面 lib/models.ts + store/models.ts。
import { localizeModelDescription, type TurnOverrides } from '@qn/codex-client'
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
    [model.displayName, model.model, model.description, localizeModelDescription(model.description)].some((value) => value.toLowerCase().includes(term)),
  )
}

const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极高',
  ultra: '极致',
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
  return [selection.model.displayName, effortLabel(selection.effort)].filter(Boolean).join(' · ')
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
      }
    }
    return result
  } catch {
    return {}
  }
}
