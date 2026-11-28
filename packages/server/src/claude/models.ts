/**
 * Claude 模型/推理强度 → Codex v2 model/list 与 turn/start 覆盖项的纯映射。
 * 模型 id 一律原样交给 Claude 自身解析（别名或 SDK 的 ModelInfo.value）；这里不读取账号/
 * 环境配置、不为了列模型启动会话，也不声明 Claude 没有的 serviceTier「快速」能力。
 */
import { asRecord, scalarText, type Json } from './v2'

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

/** 别名：交给 Claude 自己解析为账号当前默认模型。 */
export const DEFAULT_MODEL = 'default'

export interface ClaudeSettings {
  /** null = 不覆盖，沿用 Claude 自身配置。 */
  model: string | null
  effort: ClaudeEffort | null
}

export const NO_OVERRIDES: ClaudeSettings = { model: null, effort: null }

export interface SettingsDiff {
  model?: string | null
  effort?: ClaudeEffort | null
}

export interface QueryOverrides {
  model?: string
  effort?: ClaudeEffort
}

export interface ThreadModelConfig {
  model: string | null
  reasoningEffort: string | null
}

const ALIAS_NOTE = '别名，由 Claude 自身配置解析'

/** Claude Code 官方文档列出的模型别名；没拿到 SDK 真实列表时只展示这六个。 */
const STATIC_ALIASES: { id: string; displayName: string; description: string }[] = [
  { id: DEFAULT_MODEL, displayName: '账号默认', description: '使用账号当前默认模型' },
  { id: 'sonnet', displayName: 'Sonnet', description: '速度与能力均衡，适合日常编码' },
  { id: 'opus', displayName: 'Opus', description: '能力最强，适合复杂编码与长任务' },
  { id: 'haiku', displayName: 'Haiku', description: '最轻量，适合快速、简单任务' },
  { id: 'sonnet[1m]', displayName: 'Sonnet (1M)', description: '100 万 token 上下文' },
  { id: 'opusplan', displayName: 'Opus Plan', description: '规划用 Opus、执行用 Sonnet' },
]

export function isEffort(value: unknown): value is ClaudeEffort {
  return typeof value === 'string' && (CLAUDE_EFFORTS as readonly string[]).includes(value)
}

/** SDK 的 EffortLevel 与 v2 ReasoningEffort 同为字符串，按 v2 字段名原样给出。 */
export function effortOptions(levels: unknown): Json[] {
  return (Array.isArray(levels) ? levels : [])
    .filter(isEffort)
    .map((reasoningEffort) => ({ reasoningEffort, description: '' }))
}

function defaultEffort(options: Json[]): string | null {
  const values = options.map((option) => scalarText(option.reasoningEffort))
  // 没有逐模型默认值时选中档，避免选择器回落到第一档（low）而悄悄降低推理深度。
  return values.includes('medium') ? 'medium' : (values[0] ?? null)
}

/** 按 vendor/codex-protocol/ts/v2/Model.ts 补齐必填字段；缺能力一律为空/ null。 */
function v2Model(fields: {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  efforts: Json[]
}): Json {
  return {
    id: fields.id,
    model: fields.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: fields.displayName,
    description: fields.description,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: fields.efforts,
    defaultReasoningEffort: defaultEffort(fields.efforts),
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    // Claude 没有 Codex 的 serviceTier 概念；supportsFastMode 也不映射到它。
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: fields.isDefault,
  }
}

export function staticModelList(): Json {
  const efforts = effortOptions([...CLAUDE_EFFORTS])
  return {
    data: STATIC_ALIASES.map((alias, index) =>
      v2Model({
        id: alias.id,
        displayName: alias.displayName,
        description: `${ALIAS_NOTE}；${alias.description}`,
        isDefault: index === 0,
        efforts,
      }),
    ),
    nextCursor: null,
  }
}

/** Query.supportedModels() 的结果 → v2 model/list；没有有效条目时返回 null 让调用方回退别名。 */
export function supportedModelList(infos: unknown): Json | null {
  const entries = Array.isArray(infos) ? infos : []
  const hasDefault = entries.some((entry) => scalarText(asRecord(entry)?.value) === DEFAULT_MODEL)
  const data: Json[] = []
  let assignedDefault = hasDefault
  for (const raw of entries) {
    const info = asRecord(raw)
    const id = scalarText(info?.value)
    if (!info || !id) continue
    const levels = Array.isArray(info.supportedEffortLevels)
      ? info.supportedEffortLevels
      : info.supportsEffort === true
        ? [...CLAUDE_EFFORTS]
        : []
    const isDefault = hasDefault ? id === DEFAULT_MODEL : !assignedDefault
    if (isDefault) assignedDefault = true
    // 使用 SDK 报告的具体型号展示，发送时仍交给 Claude 按别名解析（包含账号默认和动态切换）。
    const resolved = scalarText(info.resolvedModel)
    const name = scalarText(info.displayName) || id
    data.push(
      v2Model({
        id,
        displayName: resolved && resolved !== id && resolved !== name ? `${resolved} (${name})` : name,
        description: scalarText(info.description),
        isDefault,
        efforts: effortOptions(levels),
      }),
    )
  }
  return data.length > 0 ? { data, nextCursor: null } : null
}

/**
 * turn/start 的覆盖项是「本次及之后生效」，未给的字段沿用会话当前设置。
 * serviceTier 是 Codex 的「快速」，Claude 不支持，显式忽略而不伪造权限/档位。
 */
export function parseOverrides(params: Json, current: ClaudeSettings = NO_OVERRIDES): ClaudeSettings {
  let model = current.model
  if (typeof params.model === 'string' && params.model.trim()) {
    const value = params.model.trim()
    model = value === DEFAULT_MODEL ? null : value
  } else if (params.model === null) {
    model = null
  }
  return {
    model,
    effort: isEffort(params.effort) ? params.effort : current.effort,
  }
}

/** 已生效设置 → 需要 setModel / applyFlagSettings 补发的差异；null 表示无变化。 */
export function settingsDiff(current: ClaudeSettings, next: ClaudeSettings): SettingsDiff | null {
  const diff: SettingsDiff = {}
  if (next.model !== current.model) diff.model = next.model
  if (next.effort !== current.effort) diff.effort = next.effort
  return Object.keys(diff).length > 0 ? diff : null
}

/** 新 query 的 options.model / options.effort；null 表示不传，由 Claude 自身配置决定。 */
export function queryOverrides(settings: ClaudeSettings): QueryOverrides {
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
  }
}

/** Thread / thread/start / turn/started 等 v2 形状里的当前配置字段。 */
export function threadModelConfig(settings: ClaudeSettings): ThreadModelConfig {
  return { model: settings.model, reasoningEffort: settings.effort }
}
