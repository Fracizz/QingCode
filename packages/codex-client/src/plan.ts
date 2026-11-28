// 计划 / TODO 清单（turn/plan/updated 与历史轮次上的 plan）：解析、进度与分页补读，桌面与手机共用。

import type { CodexRpcLike, ThreadHistoryCursor } from './api'

export type PlanStepView = { step: string; status: 'pending' | 'inProgress' | 'completed' }

/** 一份完整清单；steps 为空表示清单已被清空，界面不显示。 */
export type PlanView = { turnId: string; explanation: string | null; steps: PlanStepView[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** value 为 `{ explanation, plan }`（通知参数或历史轮次的 plan 字段）；没有清单数组时返回 null。 */
export function parsePlan(value: unknown, turnId: string): PlanView | null {
  if (!isRecord(value) || !Array.isArray(value.plan)) return null
  const steps = value.plan.flatMap((entry): PlanStepView[] => {
    if (!isRecord(entry) || typeof entry.step !== 'string' || !entry.step) return []
    const status = entry.status === 'completed' || entry.status === 'inProgress' ? entry.status : 'pending'
    return [{ step: entry.step, status }]
  })
  return { turnId, explanation: typeof value.explanation === 'string' && value.explanation ? value.explanation : null, steps }
}

/** current 是正在进行的步骤，没有时取第一个未开始的；全部完成时为 undefined。 */
export function planProgress(plan: PlanView): { done: number; total: number; current?: PlanStepView } {
  const current = plan.steps.find((item) => item.status === 'inProgress')
    ?? plan.steps.find((item) => item.status === 'pending')
  return { done: plan.steps.filter((item) => item.status === 'completed').length, total: plan.steps.length, current }
}

const EARLIER_PLAN_PAGES = 3

/**
 * 历史只把清单挂在发生变化的轮次上，最新清单可能在更早的页。
 * 只读轮次摘要（notLoaded），最多翻几页；读不到时返回 null，不影响打开会话。
 */
export async function readEarlierPlan(
  rpc: CodexRpcLike,
  threadId: string,
  earlier: ThreadHistoryCursor | null,
  isCurrent: () => boolean = () => true,
): Promise<PlanView | null> {
  let cursor = !earlier ? null : 'items' in earlier ? earlier.nextTurn : earlier.turns
  try {
    for (let page = 0; cursor && page < EARLIER_PLAN_PAGES && isCurrent(); page++) {
      const result = await rpc.request('thread/turns/list', {
        threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
      })
      if (!isCurrent()) return null
      for (const turn of Array.isArray(result?.data) ? result.data : []) {
        const plan = parsePlan((turn as { plan?: unknown }).plan, turn.id)
        if (plan) return plan
      }
      cursor = result?.nextCursor && result.nextCursor !== cursor ? result.nextCursor : null
    }
  } catch {
    // 旧版服务端不支持摘要分页时，等用户向上翻页时再取。
  }
  return null
}
