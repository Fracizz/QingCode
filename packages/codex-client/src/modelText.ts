// 模型选择器的说明文案：model/list 只给英文说明，中文界面用这里的译文，英文界面直接显示原文。电脑版与手机版共用。
import { getLocale, t, translateMessage } from '../../protocol/src/i18n'

const CJK = /[一-鿿]/

/** 中文界面统一用自己的说明，未知档位才回落到服务端原文；英文界面优先显示服务端英文原文。 */
const EFFORT_HINTS: Record<string, string> = {
  none: t('不做额外推理，响应最快'),
  off: t('不做额外推理，响应最快'),
  minimal: t('几乎不推理，适合简单改动'),
  low: t('推理较少，响应快'),
  medium: t('速度与推理深度均衡，适合大多数任务'),
  high: t('推理更深入，适合复杂问题'),
  xhigh: t('推理非常深入，耗时更长'),
  max: t('尽可能深入推理，耗时与额度消耗明显增加'),
  ultra: t('最深推理，最慢、最耗额度'),
}

export function effortHint(effort: string, fallback = ''): string {
  if (getLocale() === 'en' && fallback && !CJK.test(fallback)) return fallback
  return EFFORT_HINTS[effort] ?? translateMessage(fallback)
}

/** 已知的模型说明原文（小写、去句号）→ 中文。 */
const MODEL_DESCRIPTIONS: Record<string, string> = {
  'fast, go-to model for coding and everyday work': '速度快，日常编码与常规工作的首选', // i18n-ignore: 仅中文界面使用
  'our most capable model for complex coding and professional work': '能力最强，适合复杂编码与专业工作', // i18n-ignore: 仅中文界面使用
}

/** 没有精确译文时按关键词给出中文概括；都不匹配才显示原文（总比空着好）。 */
const MODEL_KEYWORDS: [RegExp, string][] = [
  [/most capable|frontier|flagship|most (intelligent|powerful)/i, '能力最强，适合复杂编码与专业工作'], // i18n-ignore: 仅中文界面使用
  [/cheap|cost|lightweight|small|mini|efficient/i, '更轻量、更省额度，适合简单任务'], // i18n-ignore: 仅中文界面使用
  [/fast|quick|go-to|everyday|low latency/i, '速度快，适合日常编码与常规任务'], // i18n-ignore: 仅中文界面使用
  [/reason|think|deep/i, '擅长深度推理，适合复杂问题'], // i18n-ignore: 仅中文界面使用
  [/codex|coding|agentic/i, '面向编码任务优化'], // i18n-ignore: 仅中文界面使用
]

/** 模型说明本地化：中文界面把英文描述译成中文；英文界面保留原文，只翻译目标服务发来的中文说明。 */
export function localizeModelDescription(text: string): string {
  const raw = text.trim()
  if (getLocale() === 'en') return translateMessage(raw)
  if (!raw || CJK.test(raw)) return raw
  const key = raw.toLowerCase().replace(/[.。]+$/, '').replace(/\s+/g, ' ')
  if (MODEL_DESCRIPTIONS[key]) return MODEL_DESCRIPTIONS[key]
  return MODEL_KEYWORDS.find(([pattern]) => pattern.test(raw))?.[1] ?? raw
}
