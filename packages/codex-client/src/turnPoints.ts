// 按用户消息定位轮次：文件回滚与“从上一轮分支后重发”共用。

import { t } from '../../protocol/src/i18n'
import type { ThreadView, TurnMeta } from './conversation'

/** 条目 → 所属轮次。重新载入后同一条目可能同时有实时记录和历史记录，后写入的（历史）优先。 */
function turnsByItem(turns: readonly TurnMeta[] | undefined): Map<string, TurnMeta> {
  const owners = new Map<string, TurnMeta>()
  for (const turn of turns ?? []) {
    for (const id of turn.itemIds) owners.set(id, turn)
  }
  return owners
}

/**
 * 开启一轮的用户消息 id → 轮次 id。轮内追加的引导消息不在其中：
 * 回滚与分支只能以整轮为单位，落在轮次中间的消息不能作为起点。
 */
export function turnOpeningMessages(view: Pick<ThreadView, 'items' | 'turns'> | undefined): Map<string, string> {
  const owners = turnsByItem(view?.turns)
  const opened = new Set<TurnMeta>()
  const result = new Map<string, string>()
  for (const item of view?.items ?? []) {
    const turn = owners.get(item.id)
    if (!turn || opened.has(turn)) continue
    // 只看每轮的第一个条目：Agent 自行开始的轮次里后来并入的用户消息不算开场。
    opened.add(turn)
    if (item.kind === 'user' && !item.pending && item.steering !== 'currentTurn') result.set(item.id, turn.id)
  }
  return result
}

export type BranchPoint =
  /** 保留到 turnId 这一轮（含）。 */
  | { kind: 'turn'; turnId: string }
  /** 这条消息之前没有任何轮次，开新会话即可。 */
  | { kind: 'start' }
  /** 上一轮在尚未加载的更早历史里。 */
  | { kind: 'earlier' }

/** 修改 itemId 这条消息后重发时应从哪里分支；无法确定时返回 null。 */
export function branchPoint(
  view: Pick<ThreadView, 'items' | 'turns' | 'historyCursor'> | undefined,
  itemId: string,
): BranchPoint | null {
  const index = view?.items.findIndex((item) => item.id === itemId) ?? -1
  if (!view || index < 0) return null
  const owners = turnsByItem(view.turns)
  if (!owners.has(itemId)) return null
  let unknown = false
  for (let i = index - 1; i >= 0; i--) {
    const item = view.items[i]!
    const turn = owners.get(item.id)
    if (!turn) {
      // 归属不明的对话内容之前不能当作“没有历史”。
      if (item.kind === 'user' || item.kind === 'agent') unknown = true
      continue
    }
    if (turn.itemIds.includes(itemId)) continue
    return unknown ? null : { kind: 'turn', turnId: turn.id }
  }
  if (view.historyCursor) return { kind: 'earlier' }
  return unknown ? null : { kind: 'start' }
}

/** 编辑重发需要的 Agent 能力：能回退的原地改写，只能分支的从上一轮分出新会话。 */
export type RevisionCapabilities = { revert: boolean; fork: boolean }

/**
 * 用户消息能否“编辑并重发”，电脑版与手机版共用。
 * 运行中不能改（截断历史会打断本轮）；能回退的 Agent 任意消息都可以，只能分支的只限开启一轮的消息。
 */
export function canReviseMessage(
  caps: RevisionCapabilities, running: boolean, itemId: string, turnOpeners: ReadonlyMap<string, string>,
): boolean {
  if (running) return false
  return caps.revert || (caps.fork && turnOpeners.has(itemId))
}

/** 编辑框里常驻的说明：分支重发会开新会话，原会话保留；原地回退时不需要说明。 */
export function revisionNote(caps: RevisionCapabilities, firstMessage: boolean): string | undefined {
  if (caps.revert) return undefined
  return firstMessage ? t('这是第一条消息：将开新会话发送，原会话保留。') : t('将从上一轮分出新会话发送，原会话保留。')
}
