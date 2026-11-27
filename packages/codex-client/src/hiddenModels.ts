// 用户在电脑端设置的「隐藏模型」名单：按 Agent 各一份，桌面与手机共用同一套校验和过滤。
// 用黑名单而非白名单，Agent 升级后新出的模型默认可见，不会被漏掉。
import type { AgentKind } from '../../protocol/src/messages'

export type HiddenModels = Partial<Record<AgentKind, string[]>>

const HIDDEN_AGENTS: readonly AgentKind[] = ['codex', 'claude', 'pi']
const MAX_HIDDEN_PER_AGENT = 200
const MAX_MODEL_ID_LENGTH = 256

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 单个 Agent 的名单：只留非空字符串、去重、限长，防止坏数据撑大设置文件。 */
export function sanitizeHiddenList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || id.length > MAX_MODEL_ID_LENGTH || id.includes('\0') || result.includes(id)) continue
    result.push(id)
    if (result.length >= MAX_HIDDEN_PER_AGENT) break
  }
  return result
}

/** 整张表；没有任何隐藏项时返回 undefined，让设置文件保持旧形状。 */
export function sanitizeHiddenModels(raw: unknown): HiddenModels | undefined {
  if (!isRecord(raw)) return undefined
  const result: HiddenModels = {}
  for (const agent of HIDDEN_AGENTS) {
    if (!Object.prototype.hasOwnProperty.call(raw, agent)) continue
    const list = sanitizeHiddenList(raw[agent])
    if (list.length > 0) result[agent] = list
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 补丁形状：出现的 Agent 整份替换（空数组表示清空），没出现的保持不动。
 * 与 sanitizeHiddenModels 区别在于保留空数组。
 */
export function sanitizeHiddenModelsPatch(raw: unknown): HiddenModels | undefined {
  if (!isRecord(raw)) return undefined
  const result: HiddenModels = {}
  for (const agent of HIDDEN_AGENTS) {
    if (Object.prototype.hasOwnProperty.call(raw, agent) && Array.isArray(raw[agent])) {
      result[agent] = sanitizeHiddenList(raw[agent])
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function mergeHiddenModels(base: HiddenModels | undefined, patch: HiddenModels | undefined): HiddenModels | undefined {
  return sanitizeHiddenModels({ ...(base ?? {}), ...(patch ?? {}) })
}

/** 过滤隐藏模型；当前选中的即使在名单里也保留，避免选中项从列表消失。 */
export function withoutHiddenModels<T extends { model: string }>(
  models: readonly T[],
  hidden: readonly string[] | undefined,
  selected?: string | null,
): T[] {
  if (!hidden || hidden.length === 0) return [...models]
  return models.filter((item) => item.model === selected || !hidden.includes(item.model))
}

/** 切换某个模型的隐藏状态，返回新名单。 */
export function toggleHiddenModel(hidden: readonly string[] | undefined, model: string): string[] {
  const list = hidden ?? []
  return list.includes(model) ? list.filter((item) => item !== model) : [...list, model]
}
