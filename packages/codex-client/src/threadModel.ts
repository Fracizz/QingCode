// 按会话记模型的纯逻辑：历史配置与本机选择的对应、另一端改过模型时的采用，以及中途切换模型的判断。
// 桌面与手机的模型选项形状一致，这里只依赖用得到的字段。
import { t } from '../../protocol/src/i18n'
import type { AgentKind } from '../../protocol/src/messages'
import type { TurnOverrides } from './api'

export type ModelOptionLike = {
  model: string
  isDefault: boolean
  hidden?: boolean
  efforts: { value: string }[]
  defaultEffort: string | null
  serviceTiers: { id: string; name: string }[]
}

/** 会话历史回报的配置；serviceTier 为 undefined 表示历史没回报（如 thread/read）。 */
export type SavedThreadConfig = { model: string; effort: string | null; serviceTier?: string | null }

/** 模型与强度：可以是历史原值（Claude 为完整模型 ID），也可以是选择器里的选项。 */
export type ModelConfig = { model: string | null; effort: string | null }

/**
 * 本机对某个会话的选择。seen 是写入这条记录时会话历史里的配置（或本机最近一次发送的配置），
 * 之后历史与它不同，说明另一端用别的模型发过消息。
 */
export type ThreadModelPrefs = { model: string | null; effort: string | null; fast: boolean; seen?: ModelConfig }

/**
 * 从原会话开出新会话时沿用的选择：以原会话当前选择为底，叠上首轮实际发送的覆盖项（排队消息按排队时的配置发送）。
 * seen 属于原会话的历史，不带过去。
 */
export function inheritedModelPrefs(source: ThreadModelPrefs, overrides: TurnOverrides = {}): ThreadModelPrefs {
  const { model, effort, fast } = source
  return {
    model: overrides.model || model,
    effort: overrides.effort || effort,
    fast: overrides.serviceTier === undefined ? fast : overrides.serviceTier !== null,
  }
}

/**
 * 历史回报的模型 → 选择器里的选项。精确匹配优先；Claude 历史记的是完整模型 ID（如 claude-opus-5-5），
 * 而选择器给的是别名（opus / sonnet[1m]），按去掉方括号后缀的别名被完整 ID 包含来对应，取最长的无后缀别名。
 * 对不上时返回 null，让选择器回落到默认模型，避免显示一个列表里不存在的选择。
 */
export function matchModelOption(models: readonly ModelOptionLike[], id: string): string | null {
  if (models.some((item) => item.model === id)) return id
  const base = (value: string) => value.replace(/\[[^\]]*\]/g, '').trim().toLowerCase()
  const target = base(id)
  let best: ModelOptionLike | undefined
  for (const item of models) {
    const alias = base(item.model)
    if (!alias || item.model === 'default' || !target.includes(alias)) continue
    const plain = item.model.toLowerCase() === alias
    const bestPlain = best ? best.model.toLowerCase() === base(best.model) : false
    if (!best || (plain && !bestPlain) || (plain === bestPlain && alias.length > base(best.model).length)) best = item
  }
  return best?.model ?? null
}

function fastTierOf(model: ModelOptionLike | undefined): string | null {
  return model?.serviceTiers.find((item) => /fast|priority|flex-fast/i.test(`${item.id} ${item.name}`))?.id ?? null
}

/** 配置 → 选项；模型为 null 表示跟随默认模型。 */
function optionFor(models: readonly ModelOptionLike[], model: string | null): ModelOptionLike | undefined {
  const id = model ? matchModelOption(models, model) : null
  if (model && !id) return undefined
  return id
    ? models.find((item) => item.model === id)
    : models.find((item) => item.isDefault) ?? models.find((item) => !item.hidden) ?? models[0]
}

/**
 * 两份配置是否对应同一个选择：模型按选项对应；有一方对不上选项时只比较原值。
 * Codex 的强度为空表示模型默认，按默认强度比较；Claude / pi 的历史常不含强度，任一方为空时不比较强度。
 */
export function sameModelConfig(models: readonly ModelOptionLike[], a: ModelConfig, b: ModelConfig, agent: AgentKind = 'codex'): boolean {
  const optionA = optionFor(models, a.model)
  const optionB = optionFor(models, b.model)
  if (!optionA || !optionB) return a.model === b.model && (a.effort ?? null) === (b.effort ?? null)
  if (optionA.model !== optionB.model) return false
  const fill = agent === 'codex'
  const effortA = a.effort ?? (fill ? optionA.defaultEffort : null)
  const effortB = b.effort ?? (fill ? optionB.defaultEffort : null)
  return !effortA || !effortB || effortA === effortB
}

/**
 * 历史配置 → 偏好；对不上选项（或模型列表未加载）时返回 null。
 * Codex 的强度为 null 表示会话没设，沿用模型默认；Claude / pi 缺强度时沿用 base。
 * Codex 回报了服务档位时据此恢复快速档，否则沿用 base。
 */
export function historyModelPrefs(
  agent: AgentKind,
  models: readonly ModelOptionLike[],
  base: ThreadModelPrefs,
  saved: SavedThreadConfig | undefined,
): ThreadModelPrefs | null {
  if (!saved || models.length === 0) return null
  const model = matchModelOption(models, saved.model)
  if (!model) return null
  const fast = agent === 'codex' && saved.serviceTier !== undefined
    ? saved.serviceTier !== null && saved.serviceTier === fastTierOf(models.find((item) => item.model === model))
    : base.fast
  return {
    model,
    effort: agent === 'codex' ? saved.effort : (saved.effort ?? base.effort),
    fast,
    seen: { model: saved.model, effort: saved.effort },
  }
}

/**
 * 本机已有会话记录时对照会话历史：
 * - 历史与记录时看到的一致：返回 null，保持本机选择；
 * - 历史已变但就是本机的选择（如本机发送后重新打开）：只更新 seen；
 * - 历史变成了别的模型或强度（另一端用它发过消息）：采用历史，历史没回报的字段保留本机值。
 */
export function reconcileThreadPrefs(
  agent: AgentKind,
  models: readonly ModelOptionLike[],
  own: ThreadModelPrefs,
  saved: SavedThreadConfig | undefined,
): ThreadModelPrefs | null {
  if (!saved || models.length === 0) return null
  if (own.seen && sameModelConfig(models, own.seen, saved, agent)) return null
  const seen = { model: saved.model, effort: saved.effort }
  if (sameModelConfig(models, own, saved, agent)) return { ...own, seen }
  return historyModelPrefs(agent, models, own, saved) ?? null
}

/**
 * 本轮相对上一轮是否换了模型或强度。previous 为上一轮发送时的配置（没有时用会话历史）；
 * 本轮没有显式模型（Claude / pi 沿用 Agent 自身配置）时无法判断，不提示。
 */
export function modelSwitched(
  agent: AgentKind,
  models: readonly ModelOptionLike[],
  previous: ModelConfig | undefined,
  next: { model?: string | null; effort?: string | null },
): boolean {
  if (!previous?.model || !next.model) return false
  return !sameModelConfig(models, previous, { model: next.model, effort: next.effort ?? null }, agent)
}

/**
 * 发送一轮前算出要记下的配置，以及（换了模型或强度时）插在本轮用户消息前的提示。
 * 参考 Codex：中途换模型时在对话里留一行「模型已切换为 …」。anchor 为本轮用户消息的 clientId。
 */
export function turnModelNote(
  agent: AgentKind,
  models: readonly ModelOptionLike[],
  thread: { lastTurnConfig?: ModelConfig; savedConfig?: SavedThreadConfig } | undefined,
  overrides: { model?: string | null; effort?: string | null },
  anchor: string,
  label: (config: { model: string; effort: string | null }) => string,
): { config: { model: string; effort: string | null }; notice?: { id: string; text: string; anchor: string } } | null {
  if (!overrides.model) return null
  const config = { model: overrides.model, effort: overrides.effort ?? null }
  const previous = thread?.lastTurnConfig ?? thread?.savedConfig
  if (!modelSwitched(agent, models, previous, overrides)) return { config }
  const text = label(config)
  return text ? { config, notice: { id: `model-switch-${anchor}`, text: t('模型已切换为 {model}', { model: text }), anchor } } : { config }
}
