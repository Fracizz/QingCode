// 模型选择器的纯逻辑：模型列表过滤、推理强度/速度档位、偏好解析、上下文占用。

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

/** 服务端给的强度说明是英文，界面统一用自己的中文说明；未知档位才回落到服务端原文。 */
const EFFORT_HINTS: Record<string, string> = {
  none: '不做额外推理，响应最快',
  off: '不做额外推理，响应最快',
  minimal: '几乎不推理，适合简单改动',
  low: '推理较少，响应快',
  medium: '速度与推理深度均衡，适合大多数任务',
  high: '推理更深入，适合复杂问题',
  xhigh: '推理非常深入，耗时更长',
  max: '尽可能深入推理，耗时与额度消耗明显增加',
  ultra: '最深推理，最慢、最耗额度',
}

export function effortLabel(effort: string | null | undefined): string {
  if (!effort) return ''
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function effortHint(effort: string, fallback = ''): string {
  return EFFORT_HINTS[effort] ?? fallback
}

/** 已知的模型说明原文（小写、去句号）→ 中文。 */
const MODEL_DESCRIPTIONS: Record<string, string> = {
  'fast, go-to model for coding and everyday work': '速度快，日常编码与常规工作的首选',
  'our most capable model for complex coding and professional work': '能力最强，适合复杂编码与专业工作',
}

/** 没有精确译文时按关键词给出中文概括；都不匹配才显示原文（总比空着好）。 */
const MODEL_KEYWORDS: [RegExp, string][] = [
  [/most capable|frontier|flagship|most (intelligent|powerful)/i, '能力最强，适合复杂编码与专业工作'],
  [/cheap|cost|lightweight|small|mini|efficient/i, '更轻量、更省额度，适合简单任务'],
  [/fast|quick|go-to|everyday|low latency/i, '速度快，适合日常编码与常规任务'],
  [/reason|think|deep/i, '擅长深度推理，适合复杂问题'],
  [/codex|coding|agentic/i, '面向编码任务优化'],
]

/** 模型说明中文化：model/list 只给英文描述。已是中文的原样返回。 */
export function localizeModelDescription(text: string): string {
  const raw = text.trim()
  if (!raw || /[一-鿿]/.test(raw)) return raw
  const key = raw.toLowerCase().replace(/[.。]+$/, '').replace(/\s+/g, ' ')
  if (MODEL_DESCRIPTIONS[key]) return MODEL_DESCRIPTIONS[key]
  return MODEL_KEYWORDS.find(([pattern]) => pattern.test(raw))?.[1] ?? raw
}

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
  return [selection.model.displayName, effortLabel(selection.effort)].filter(Boolean).join(' · ')
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
      }
    }
    return result
  } catch {
    return {}
  }
}

export { contextUsage, formatTokens, type ContextUsage } from '@qn/codex-client'
