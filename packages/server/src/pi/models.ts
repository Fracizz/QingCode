/**
 * pi 模型选择：官方 RPC get_available_models / get_state → v2 model/list；
 * turn/start 的 model/effort → set_model / set_thinking_level。只用 pi 公开命令，不读写 pi 配置文件。
 */
import { asRecord, scalarText, type Json } from '../claude/v2'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
// 未选中模型时拿不到逐模型的档位，先给 pi 文档里所有推理模型都支持的基础档位。
const BASE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high']

/** v2 的 model 字段用 provider/id 组合，保证跨提供方唯一。 */
export function piModelKey(model: unknown): string {
  const record = asRecord(model)
  const provider = scalarText(record?.provider)
  const id = scalarText(record?.id)
  if (!id) return ''
  return provider ? `${provider}/${id}` : id
}

export function parsePiModelKey(key: string): { provider: string; modelId: string } | null {
  const index = key.indexOf('/')
  if (index <= 0 || index === key.length - 1) return null
  return { provider: key.slice(0, index), modelId: key.slice(index + 1) }
}

export function isPiLevel(value: unknown): value is string {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

export function piModelList(
  models: unknown[],
  current: { model?: unknown; thinkingLevel?: unknown; levels?: unknown },
): Json {
  const currentKey = piModelKey(current.model)
  const currentLevels = Array.isArray(current.levels) ? current.levels.filter(isPiLevel) : []
  const data: Json[] = []
  for (const raw of models) {
    const record = asRecord(raw)
    const key = piModelKey(record)
    if (!record || !key) continue
    const isCurrent = key === currentKey
    const levels = record.reasoning === true ? (isCurrent && currentLevels.length > 0 ? currentLevels : BASE_LEVELS) : []
    const provider = scalarText(record.provider)
    data.push({
      id: key,
      model: key,
      displayName: scalarText(record.name) || scalarText(record.id),
      description: provider ? `提供方 ${provider}` : '',
      hidden: false,
      isDefault: isCurrent,
      supportedReasoningEfforts: levels.map((level) => ({ reasoningEffort: level, description: '' })),
      defaultReasoningEffort:
        isCurrent && isPiLevel(current.thinkingLevel) && levels.includes(current.thinkingLevel)
          ? current.thinkingLevel
          : levels.includes('medium')
            ? 'medium'
            : null,
      serviceTiers: [],
    })
  }
  return { data, nextCursor: null }
}
