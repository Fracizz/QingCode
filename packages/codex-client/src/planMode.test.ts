import { describe, expect, it } from 'vitest'
import { applyNotification, applyServerRequest, emptyState } from './conversation'
import { completedPlanExit, planApproval } from './planMode'
import type { ServerNotification, ServerRequest } from './codex-types'

const plan = '# 方案\n\n' + '步骤。'.repeat(300)
const exitItem = (status: string, args: unknown = { plan }) => ({
  type: 'dynamicToolCall', id: 'item-1', namespace: null, tool: 'ExitPlanMode', arguments: args, status,
})
const notification = (method: string, item: unknown) =>
  ({ method, params: { threadId: 't', turnId: 'u', item } }) as unknown as ServerNotification
const request = (itemId: string, command: string) => ({
  id: 'approval-1', method: 'item/commandExecution/requestApproval',
  params: { threadId: 't', turnId: 'u', itemId, command },
}) as unknown as ServerRequest

describe('计划模式审批', () => {
  const started = applyNotification(emptyState(), notification('item/started', exitItem('inProgress')))

  it('审批能取到工具条目里的完整计划', () => {
    const view = applyServerRequest(started, request('item-1', 'ExitPlanMode {"plan":"…"}')).threads.t!
    expect(planApproval(view, view.pendingApprovals[0]!)).toEqual({ itemId: 'item-1', plan })
  })

  it('审批早于条目归属时按工具名找最近一条计划', () => {
    const view = applyServerRequest(started, request('u-tool', 'ExitPlanMode {}')).threads.t!
    expect(planApproval(view, view.pendingApprovals[0]!)).toEqual({ itemId: 'item-1', plan })
    const alone = applyServerRequest(emptyState(), request('u-tool', 'ExitPlanMode {}')).threads.t!
    expect(planApproval(alone, alone.pendingApprovals[0]!)).toEqual({ plan: '' })
  })

  it('普通命令审批不算', () => {
    const view = applyServerRequest(started, request('other', 'echo ExitPlanMode ')).threads.t!
    expect(planApproval(view, view.pendingApprovals[0]!)).toBeNull()
  })

  it('完成条目缺少参数时保留已有计划', () => {
    const done = applyNotification(started, notification('item/completed', exitItem('completed', {})))
    expect(done.threads.t?.items[0]).toMatchObject({ kind: 'other', plan, status: 'completed' })
  })

  it('只有批准成功的完成通知算退出计划模式', () => {
    expect(completedPlanExit(notification('item/completed', exitItem('completed')))).toEqual({ threadId: 't', itemId: 'item-1' })
    expect(completedPlanExit(notification('item/completed', exitItem('failed')))).toBeNull()
    expect(completedPlanExit(notification('item/started', exitItem('completed')))).toBeNull()
    expect(completedPlanExit(notification('item/completed', { ...exitItem('completed'), tool: 'Read' }))).toBeNull()
  })
})
