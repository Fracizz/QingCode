import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentKind } from '@qn/protocol'
import type { AgentHost } from '../codexHost'
import { ScheduleRunner } from './runner'

const agents = ['codex', 'claude', 'pi'] as const

function setup(agent: AgentKind, sandbox = 'readOnly') {
  const threadId = 'scheduled-thread'
  const turnId = 'scheduled-turn'
  const update = vi.fn(() => true)
  const open = vi.fn(async () => ({ initialize: null, lastSeq: 0 }))
  const send = vi.fn((_clientId: number, msg: { id: number; method: string; params: unknown }) => {
    if (msg.method === 'thread/start') {
      runner.receiveResponse(agent, { id: msg.id, result: {
        thread: { id: threadId }, sandbox: { type: sandbox }, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      } })
    } else if (msg.method === 'turn/start') {
      runner.receive(agent, { method: 'turn/started', params: { threadId, turn: { id: turnId } } })
      runner.receiveResponse(agent, { id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } })
    } else if (msg.method === 'turn/interrupt') {
      runner.receive(agent, { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } })
    }
  })
  const host = { open, handleClientMessage: send, detach: vi.fn() } as unknown as AgentHost
  const runner = new ScheduleRunner({ codex: host, claude: host, pi: host })
  return {
    runner, update, open, send, threadId, turnId,
    start: () => runner.start({ taskId: 'task', agent, cwd: '/project', prompt: 'Hello', runtime: {}, update }),
  }
}

afterEach(() => vi.useRealTimers())

describe('定时会话执行器', () => {
  it.each(agents)('用 %s 的原生权限启动独立会话，并关联准确的轮次', async (agent) => {
    const { runner, update, start, open, send, threadId, turnId } = setup(agent)
    start()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(open).toHaveBeenCalledWith({ requireSameConfiguration: true })
    expect(send.mock.calls[0]?.[1]).toMatchObject({ method: 'thread/start', params: { cwd: '/project', ephemeral: false } })
    const params = send.mock.calls[1]?.[1].params
    expect(params).toMatchObject({ threadId, input: [{ type: 'text', text: 'Hello' }] })
    if (agent === 'codex') expect(params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user', approvalPolicy: 'on-request',
    })
    if (agent === 'claude') expect(params).toMatchObject({ claudePermissionMode: 'plan' })
    if (agent === 'pi') expect(params).toEqual({ threadId, input: [{ type: 'text', text: 'Hello', text_elements: [] }] })

    runner.receive(agent, { method: 'turn/completed', params: { threadId, turn: { id: 'unrelated', status: 'completed' } } })
    expect(runner.busy).toBe(true)
    runner.receive(agent, { id: 'approval', method: 'item/tool/requestUserInput', params: { threadId, turnId } })
    expect(update).toHaveBeenLastCalledWith({ status: 'waiting', threadId })
    expect(send).toHaveBeenCalledTimes(2)
    runner.receive(agent, { method: 'serverRequest/resolved', params: { requestId: 'approval' } })
    expect(update).toHaveBeenLastCalledWith({ status: 'running', threadId })
    runner.receive(agent, { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'succeeded', threadId }), undefined)
    expect(runner.busy).toBe(false)
  })

  it('Codex 未确认只读权限时不发提示词', async () => {
    const { update, send, start } = setup('codex', 'workspaceWrite')
    start()
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', reason: 'permissionsUnavailable',
    }), undefined))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('保留 Claude 拒绝时给出的限额重置时间并中断轮次', async () => {
    const { runner, send, update, start, threadId } = setup('claude')
    start()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    const reset = Math.floor(Date.now() / 1000) + 600
    runner.receive('claude', { method: 'account/rateLimits/updated', params: {
      rateLimits: { rateLimitReachedType: 'rate_limit_reached', rejectionResetsAt: reset },
    } })
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'turn/interrupt' })
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'rateLimited', threadId }), reset * 1000)
  })

  it('超时后只发送一次对本轮的中断', async () => {
    vi.useFakeTimers()
    const { start, send, update, threadId, turnId } = setup('pi')
    start()
    await vi.advanceTimersByTimeAsync(3600_000)
    expect(send.mock.calls[2]?.[1]).toMatchObject({ method: 'turn/interrupt', params: { threadId, turnId } })
    expect(send).toHaveBeenCalledTimes(3)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'interrupted', reason: 'timeout' }), undefined)
  })
})
