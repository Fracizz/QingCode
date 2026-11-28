// plan 模式的退出审批（ExitPlanMode）：取完整计划、识别批准结果，桌面与手机共用。

import type { ApprovalView, ThreadView } from './conversation'

const PLAN_EXIT_TOOL = 'ExitPlanMode'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 退出计划模式的工具条目携带完整计划（审批卡的参数摘要会被截断）；其他条目返回 undefined。 */
export function planExitText(item: Record<string, unknown>): string | undefined {
  if (item.type !== 'dynamicToolCall' || item.tool !== PLAN_EXIT_TOOL) return undefined
  const plan = isRecord(item.arguments) ? item.arguments.plan : undefined
  return typeof plan === 'string' ? plan : ''
}

/**
 * 这条审批是不是“批准计划、退出计划模式”。是则返回完整计划（取不到时为空串），否则返回 null。
 * 客户端不得自动应答它；用户批准后要把本地的访问模式切出 plan，服务端不发模式变化通知。
 */
export function planApproval(
  view: ThreadView | undefined,
  approval: ApprovalView,
): { itemId?: string; plan: string } | null {
  const raw = isRecord(approval.raw) && isRecord(approval.raw.params) ? approval.raw.params : undefined
  const named = typeof raw?.command === 'string' && raw.command.startsWith(`${PLAN_EXIT_TOOL} `)
  const items = view?.items ?? []
  // 审批请求可能早于工具条目到达，此时按工具名取最近一条还没结束的计划。
  const item = items.find((entry) => entry.id === approval.itemId && entry.kind === 'other' && entry.plan !== undefined)
    ?? (named ? items.findLast((entry) => entry.kind === 'other' && entry.plan !== undefined
      && entry.status !== 'completed' && entry.status !== 'failed') : undefined)
  if (item?.kind === 'other') return { itemId: item.id, plan: item.plan ?? '' }
  return named ? { plan: '' } : null
}

/** 实时通知里“计划已获批准”的结果（可能由另一端批准）；返回所在会话与条目。 */
export function completedPlanExit(notification: { method: string; params?: unknown }): { threadId: string; itemId: string } | null {
  if (notification.method !== 'item/completed' || !isRecord(notification.params)) return null
  const { threadId, item } = notification.params
  if (typeof threadId !== 'string' || !isRecord(item) || typeof item.id !== 'string') return null
  return planExitText(item) !== undefined && item.status === 'completed' ? { threadId, itemId: item.id } : null
}
