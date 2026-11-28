import type { ItemView, TrackedSteer } from '@qn/codex-client'
import type { AccessAddress } from './accessPrefs'
import type { QueuedSend } from './queuedSends'

/** 已提交、还没确认送达的引导（含不显示占位的 Agent）；restoredId 有值表示判定未送达、已放回发送队列。 */
export type SteerRecord = TrackedSteer & {
  address: AccessAddress
  message: Pick<QueuedSend, 'text' | 'annotations' | 'attachments' | 'delegate' | 'overrides'>
  accepted?: boolean
  restoredId?: string
}

/**
 * 已发出但 Agent 还没回显的引导消息。Claude 只在实际消费输入后才回显（常见是本轮结束时），
 * 期间对话里没有任何痕迹，所以手机端先在输入框上方保留一条本地占位，避免看起来像消息被吞掉。
 */
export type PendingSteer = {
  /** 即 turn/steer 的 clientUserMessageId，服务端回显条目的 id / clientId 与之一致。 */
  id: string
  text: string
  attachments: number
  sentAt: number
}

/** 回显到达后占位就该消失：条目 id 或 clientId 与引导消息 id 一致即视为已接收。 */
export function echoedSteerIds(pending: readonly PendingSteer[], items: readonly ItemView[]): string[] {
  if (pending.length === 0) return []
  const seen = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'user') continue
    seen.add(item.id)
    if (item.clientId) seen.add(item.clientId)
  }
  return pending.filter((steer) => seen.has(steer.id)).map((steer) => steer.id)
}

export function withPendingSteer(
  all: Record<string, PendingSteer[]>, key: string, steer: PendingSteer,
): Record<string, PendingSteer[]> {
  const list = all[key] ?? []
  if (list.some((entry) => entry.id === steer.id)) return all
  return { ...all, [key]: [...list, steer] }
}

export function withoutPendingSteers(
  all: Record<string, PendingSteer[]>, key: string, ids: readonly string[],
): Record<string, PendingSteer[]> {
  const list = all[key]
  if (!list || ids.length === 0) return all
  const rest = list.filter((entry) => !ids.includes(entry.id))
  if (rest.length === list.length) return all
  const next = { ...all }
  if (rest.length === 0) delete next[key]
  else next[key] = rest
  return next
}
