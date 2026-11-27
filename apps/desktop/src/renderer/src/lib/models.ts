// 模型选择器的纯逻辑：模型列表过滤、推理强度/速度档位、偏好解析、上下文占用。
import { getLocale, localizeModelDescription, translateMessage } from '@qn/codex-client'

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
}

/** 每个 agent 的模型偏好：model 为 null 表示跟随服务端默认。 */
export type ModelPrefs = {
  model: string | null
  effort: string | null
  fast: boolean
  /** 只用于会话记录：写入时会话历史里的配置，用来发现另一端是否换过模型。 */
  seen?: { model: string | null; effort: string | null }
}

export const EMPTY_PREFS: ModelPrefs = { model: null, effort: null, fast: false }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** model/list 的原始结果 → 选择器需要的形状；字段缺失的条目直接丢弃，不让坏数据进 UI。 */
export function toModelOptions(raw: unknown): ModelOption[] {
  const list = Array.isArray(raw) ? raw : []
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
    })
  }
  return options
}

/** 搜索：名称、模型 id、描述任一包含关键字（不区分大小写）；隐藏模型只在搜索时出现。 */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return models.filter((model) => !model.hidden)
  return models.filter((model) =>
    [model.displayName, model.model, model.description, localizeModelDescription(model.description)].some((value) => value.toLowerCase().includes(q)),
  )
}

// 档位名按语言分两张表而不走词典：“关闭”“高”等单词在别处是另一种英文说法。
const EFFORT_LABELS: Record<string, string> = getLocale() === 'en'
  ? { none: 'Off', off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
  : {
      none: '关闭', // i18n-ignore: 中文档位名
      off: '关闭', // i18n-ignore: 中文档位名
      minimal: '最低', // i18n-ignore: 中文档位名
      low: '低', // i18n-ignore: 中文档位名
      medium: '中', // i18n-ignore: 中文档位名
      high: '高', // i18n-ignore: 中文档位名
      xhigh: '超高', // i18n-ignore: 中文档位名
      max: '极高', // i18n-ignore: 中文档位名
      ultra: '极致', // i18n-ignore: 中文档位名
    }

export function effortLabel(effort: string | null | undefined): string {
  if (!effort) return ''
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

export { effortHint, localizeModelDescription } from '@qn/codex-client'

/** "快速"档：优先找 id/名称里带 fast/priority 的服务档位；没有就认为该模型不支持加速。 */
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

/**
 * 偏好 + 当前模型列表 → 实际生效的选择。
 * 偏好里的模型已下线时回落到默认模型；强度不被该模型支持时回落到模型默认强度。
 */
export function resolveSelection(models: ModelOption[], prefs: ModelPrefs): ResolvedSelection {
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

/** 生效选择 → turn/start 覆盖项。没有模型列表（如 Claude 桥接）时不发任何覆盖。 */
export function turnOverrides(selection: ResolvedSelection): {
  model?: string
  effort?: string
  serviceTier?: string | null
} {
  if (!selection.model) return {}
  return {
    model: selection.model.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...(selection.fastTier ? { serviceTier: selection.fast ? selection.fastTier : null } : {}),
  }
}

export function triggerLabel(selection: ResolvedSelection): string {
  if (!selection.model) return ''
  return [translateMessage(selection.model.displayName), effortLabel(selection.effort)].filter(Boolean).join(' · ')
}

/** localStorage 中的偏好表（按 agent）；损坏数据回落为空。 */
export function parsePrefs(raw: string | null | undefined): Record<string, ModelPrefs> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) return {}
    const result: Record<string, ModelPrefs> = {}
    for (const [agent, entry] of Object.entries(value)) {
      if (!isRecord(entry)) continue
      result[agent] = {
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

export { contextUsage, formatTokens, type ContextUsage } from '@qn/codex-client'

/** 会话记录里的 seen（写入时会话历史的配置），见 @qn/codex-client 的 ThreadModelPrefs。 */
function parseSeen(value: unknown): { seen?: { model: string | null; effort: string | null } } {
  if (!isRecord(value)) return {}
  return { seen: { model: text(value.model) || null, effort: text(value.effort) || null } }
}
