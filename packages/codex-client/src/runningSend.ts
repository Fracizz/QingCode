// 运行中发送的纯逻辑（桌面与手机共用）：设置项取值、能否引导当前一轮、引导不可用时改走哪条路径。

import { AGENT_CAPABILITIES } from '../../protocol/src/agents'
import type { AgentKind } from '../../protocol/src/messages'
import type { UserInput } from './codex-types'
import type { ThreadView } from './conversation'
import { CodexRpcError } from './rpc'

/** 一次发送的处理方式：排队、引导当前一轮、打断当前一轮后发送。 */
export type SendMode = 'queue' | 'steer' | 'immediate'

/** 设置项“运行中发送”的取值。 */
export type RunningSendPreference = 'steer' | 'queue' | 'interrupt'

export const RUNNING_SEND_PREFERENCES: readonly RunningSendPreference[] = ['steer', 'queue', 'interrupt']
export const DEFAULT_RUNNING_SEND: RunningSendPreference = 'steer'

export function parseRunningSend(value: unknown): RunningSendPreference {
  return RUNNING_SEND_PREFERENCES.find((item) => item === value) ?? DEFAULT_RUNNING_SEND
}

export function runningSendMode(preference: RunningSendPreference): SendMode {
  return preference === 'interrupt' ? 'immediate' : preference
}

/** 快捷键临时改用的另一种方式：默认排队时改为引导，其余改为排队。打断有副作用，不作为备选。 */
export function alternateSendMode(preference: RunningSendPreference): SendMode {
  return preference === 'queue' ? 'steer' : 'queue'
}

/** 以 `/名字` 开头的正文；路径（如 /usr/bin）不算。 */
const SLASH_COMMAND = /^\s*\/[\p{L}\p{N}_.:-]+(?=\s|$)/u

/**
 * 斜杠命令只能作为一轮的开头发送。Claude、pi 的桥会把技能输入拼成 `/技能名` 前缀，同样按命令处理；
 * Codex 的技能是结构化输入，可以引导。
 */
export function isSlashDraft(agent: AgentKind, text: string, skillCount = 0): boolean {
  return (agent !== 'codex' && skillCount > 0) || SLASH_COMMAND.test(text)
}

export function isSlashInput(agent: AgentKind, input: readonly UserInput[]): boolean {
  const text = input.find((item) => item.type === 'text')
  return isSlashDraft(agent, text?.type === 'text' ? text.text : '', input.filter((item) => item.type === 'skill').length)
}

/** 与具体消息无关、当前一轮不能引导的原因。 */
export type TurnSteerBlock = 'unsupported' | 'noTurn' | 'compacting' | 'review'
export type SteerBlock = TurnSteerBlock | 'turnChanged' | 'slash'

/** 运行中的一轮能否引导；compactionStarting 表示手动压缩已发起、轮次事件还没到。 */
export function turnSteerBlock(agent: AgentKind, view: ThreadView | undefined, compactionStarting = false): TurnSteerBlock | null {
  if (compactionStarting) return 'compacting'
  if (!AGENT_CAPABILITIES[agent].steer) return 'unsupported'
  if (view?.status !== 'running' || !view.activeTurnId) return 'noTurn'
  const ids = new Set(view.turns?.find((turn) => turn.id === view.activeTurnId)?.itemIds)
  let reviewing = false
  for (const item of view.items) {
    if (item.kind !== 'other' || !ids.has(item.id)) continue
    if (item.type === 'contextCompaction' && item.status === 'inProgress') return 'compacting'
    if (item.type === 'enteredReviewMode') reviewing = true
    else if (item.type === 'exitedReviewMode') reviewing = false
  }
  return reviewing ? 'review' : null
}

export type SteerPlan =
  /** 引导 turnId 这一轮。 */
  | { route: 'steer'; turnId: string }
  /** 没有运行中的轮次，按普通消息发送。 */
  | { route: 'send' }
  /** 现在不能引导，转入排队。 */
  | { route: 'queue'; reason: SteerBlock }

/** expectedTurnId：用户按下发送时看到的轮次；之后换了一轮就改为排队。 */
export function planSteer({ agent, view, input, compactionStarting = false, expectedTurnId }: {
  agent: AgentKind
  view: ThreadView | undefined
  input: readonly UserInput[]
  compactionStarting?: boolean
  expectedTurnId?: string
}): SteerPlan {
  if (compactionStarting) return { route: 'queue', reason: 'compacting' }
  if (view?.status !== 'running') return { route: 'send' }
  const turnId = view.activeTurnId
  if (expectedTurnId && turnId !== expectedTurnId) return { route: 'queue', reason: 'turnChanged' }
  const blocked = turnSteerBlock(agent, view)
  if (blocked) return { route: 'queue', reason: blocked }
  if (isSlashInput(agent, input)) return { route: 'queue', reason: 'slash' }
  return { route: 'steer', turnId: turnId! }
}

// JSON-RPC 的请求无效、方法不存在、参数无效：Agent 或桥确实收到并拒绝了。
const REJECTED_CODES: readonly number[] = [-32600, -32601, -32602]

/**
 * 引导是否被明确拒绝（消息肯定没有送达，可以改走其他路径）。
 * 超时、断线、进程退出（-32000 等）无法确认是否送达，调用方不能自动重发。
 */
export function isSteerRejected(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) return false
  if (REJECTED_CODES.includes(error.code)) return true
  const info = (error.data as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo
  return typeof info === 'object' && info !== null && 'activeTurnNotSteerable' in info
}
