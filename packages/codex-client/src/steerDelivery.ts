// 引导消息的送达判断：停止时被撤回的引导不会回显，轮次结束后要按“未送达”处理，不自动重发。

import type { ThreadView } from './conversation'

export type TrackedSteer = {
  /** 随 turn/steer 发送的 clientUserMessageId，服务端回显的用户消息带同一 ID。 */
  clientId: string
  /** 引导的目标轮次。 */
  turnId: string
  /** 客户端是否先放了本地占位气泡；旧版回显不带 clientId 时占位会被直接替换掉。 */
  optimistic?: boolean
}

export type SteerOutcome = 'delivered' | 'waiting' | 'undelivered'

/** 轮次结束后等待回显的时间：Agent 可能紧接着开下一轮处理这条引导。 */
export const STEER_ECHO_GRACE_MS = 1500

/**
 * 在 turn/completed 之后经过 STEER_ECHO_GRACE_MS 再判断。
 * 目标轮次结束后，会话已停下或又有一轮结束仍没有回显，才算未送达。
 */
export function steerOutcome(view: ThreadView | undefined, steer: TrackedSteer): SteerOutcome {
  if (!view) return 'waiting'
  const echo = view.items.find((item) => item.kind === 'user'
    && (item.id === steer.clientId || item.clientId === steer.clientId))
  if (echo?.kind === 'user' && !echo.pending) return 'delivered'
  if (!echo && steer.optimistic) return 'delivered'
  const turns = view.turns ?? []
  const index = turns.findIndex((turn) => turn.id === steer.turnId)
  if (index < 0 || !turns[index]!.outcome) return 'waiting'
  if (view.status === 'running' && !turns.slice(index + 1).some((turn) => turn.outcome)) return 'waiting'
  return 'undelivered'
}
