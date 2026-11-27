import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentKind } from '../../../shared/backendApi'
import { sessionKey } from '../lib/agents'
import { pendingSendKey, useCodex } from './codex'

type RpcRequest = { id: string; method: string; params: Record<string, unknown> }

const backend = vi.hoisted(() => ({
  listeners: new Set<(payload: unknown) => void>(),
  send: vi.fn<(agent: AgentKind, msg: RpcRequest) => void>(),
}))

vi.mock('../lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/backend')>(),
  call: async (method: string, params: { agent: AgentKind; msg: RpcRequest }) => {
    if (method === 'codex.send') backend.send(params.agent, params.msg)
    return { lastSeq: 0 }
  },
  on: (name: string, listener: (payload: unknown) => void) => {
    if (name === 'codex.recv') backend.listeners.add(listener)
    return () => backend.listeners.delete(listener)
  },
}))

const targetId = 'test-target'
const threadId = 'test-thread'
const chat = { targetId, threadId, agent: 'codex' } as const
const pending = () => useCodex.getState().pendingSends[pendingSendKey(chat)] ?? []

function receive(agent: AgentKind, msg: unknown) {
  for (const listener of backend.listeners) listener({ agent, targetId, seq: null, msg })
}

function notifyTurn(method: 'turn/started' | 'turn/completed', id: string, status: string, agent: AgentKind = 'codex') {
  receive(agent, { method, params: { threadId, turn: { id, status, items: [] } } })
}

const methods = () => backend.send.mock.calls.map(([, msg]) => msg.method)

describe('聊天发送方式', () => {
  beforeEach(async () => {
    for (const session of Object.values(useCodex.getState().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
    backend.send.mockReset()
    backend.send.mockImplementation((agent, { id, method }) => {
      const result = method === 'turn/start' ? { turn: { id, status: 'inProgress', items: [] } } : {}
      receive(agent, { id, result })
    })
    useCodex.setState({
      sessions: {}, pendingSends: {}, sending: false,
      currentTargetId: null, currentThreadId: null, error: null, notice: null,
    })
    await useCodex.getState().ensureOpen(targetId, 'codex')
    notifyTurn('turn/started', 'active', 'inProgress')
  })

  it('默认入队，按顺序等待每一轮完成，并允许移除未发消息', async () => {
    const { send, removePendingSend } = useCodex.getState()
    expect(await send('第一个', chat)).toBe(true)
    expect(await send('移除', chat)).toBe(true)
    expect(await send('最后一个', chat)).toBe(true)
    removePendingSend(chat, pending()[1]!.id)
    expect(methods()).toEqual([])
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(pending().map((item) => item.text)).toEqual(['最后一个']))
    expect(methods()).toEqual(['turn/start'])
    notifyTurn('turn/completed', 'c1', 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(backend.send.mock.calls.map(([, msg]) => msg.params.input)).toEqual([
      [{ type: 'text', text: '第一个', text_elements: [] }],
      [{ type: 'text', text: '最后一个', text_elements: [] }],
    ])
  })

  it('引导附带当前 turn ID，不抢占已有队列，同时 Claude 不发送引导请求', async () => {
    const { send, ensureOpen } = useCodex.getState()
    await send('等候', chat)
    expect(await send('补充要求', { ...chat, mode: 'steer' })).toBe(true)
    expect(methods()).toEqual(['turn/steer'])
    expect(backend.send.mock.calls[0]?.[1].params.expectedTurnId).toBe('active')
    expect(pending().map((item) => item.text)).toEqual(['等候'])

    await ensureOpen(targetId, 'claude')
    notifyTurn('turn/started', 'claude-active', 'inProgress', 'claude')
    expect(await send('补充要求', { ...chat, agent: 'claude', mode: 'steer' })).toBe(false)
    expect(methods()).toEqual(['turn/steer'])
  })

  it('立即发送等待当前一轮结束，优先送出修正，原队列保留', async () => {
    const { send } = useCodex.getState()
    await send('等候', chat)
    const immediate = send('优先发送', { ...chat, mode: 'immediate' })
    const items = () => useCodex.getState().sessions[sessionKey(targetId, 'codex')]?.state.threads[threadId]?.items
    expect(useCodex.getState().sendingMessage).toMatchObject({
      key: pendingSendKey(chat),
      preview: { kind: 'user', text: '优先发送', pending: true },
    })
    await vi.waitFor(() => expect(methods()).toEqual(['turn/interrupt']))
    receive('codex', {
      method: 'item/agentMessage/delta',
      params: { threadId, turnId: 'active', itemId: 'old-reply', delta: '旧轮次的回复' },
    })
    // 增量会合并延后写入，等冲刷后再断言。
    await vi.waitFor(() => expect(items()).toMatchObject([{ kind: 'agent', text: '旧轮次的回复' }]))
    notifyTurn('turn/completed', 'active', 'interrupted')
    expect(await immediate).toBe(true)
    expect(items()).toMatchObject([{ kind: 'agent', text: '旧轮次的回复' }, { kind: 'user', text: '优先发送' }])
    expect(useCodex.getState().sendingMessage).toBeNull()
    expect(methods()).toEqual(['turn/interrupt', 'turn/start'])
    expect(pending().map((item) => item.text)).toEqual(['等候'])
    notifyTurn('turn/completed', 'c2', 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/interrupt', 'turn/start', 'turn/start'])
  })

  it('失败后暂停队列，显式继续才派发', async () => {
    await useCodex.getState().send('等候', chat)
    notifyTurn('turn/completed', 'active', 'failed')
    expect(methods()).toEqual([])
    expect(pending()[0]?.error).toContain('队列已暂停')
    useCodex.getState().retryPendingSend(chat)
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/start'])
  })

  it('会话被其他 Codex 占用时可查看历史，释放后重新发送原会话', async () => {
    useCodex.setState({ currentTargetId: targetId })
    let occupied = true
    const thread = { id: threadId, status: { type: 'idle' }, turns: [] }
    backend.send.mockImplementation((agent, { id, method }) => {
      if (method === 'thread/resume' && occupied) {
        receive(agent, { id, error: { code: -32600, message: `thread ${threadId} already has an active writer` } })
      } else {
        const result = method === 'turn/start' ? { turn: { id, status: 'inProgress', items: [] } }
          : method === 'thread/turns/list' ? { data: [], nextCursor: null } : { thread }
        receive(agent, { id, result })
      }
    })

    const { openThread, send } = useCodex.getState()
    await openThread(threadId, 'codex')
    expect(useCodex.getState().currentThreadId).toBe(threadId)
    expect(useCodex.getState().notice).toContain('可查看历史')
    expect(await send('继续', { agent: 'codex' })).toBe(false)
    expect(useCodex.getState().error).toContain('另一个 Codex 进程占用')
    expect(methods()).toEqual(['thread/resume', 'thread/read', 'thread/turns/list', 'thread/resume'])

    occupied = false
    expect(await send('继续', { agent: 'codex' })).toBe(true)
    expect(methods()).toEqual([
      'thread/resume', 'thread/read', 'thread/turns/list', 'thread/resume', 'thread/resume', 'thread/turns/list', 'turn/start',
    ])
    expect(backend.send.mock.lastCall?.[1].params).toMatchObject({
      threadId,
      input: [{ type: 'text', text: '继续', text_elements: [] }],
    })
  })

  it('上一条在回包前已完成时，仍会派发下一条', async () => {
    const { send } = useCodex.getState()
    await send('第一条', chat)
    await send('第二条', chat)
    backend.send.mockImplementation((agent, { id }) => {
      notifyTurn('turn/started', id, 'inProgress', agent)
      notifyTurn('turn/completed', id, 'completed', agent)
      receive(agent, { id, result: { turn: { id, status: 'inProgress', items: [] } } })
    })
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/start', 'turn/start'])
  })

  it('排队消息在回包前执行失败时，将暂停状态留给下一条', async () => {
    const { send } = useCodex.getState()
    await send('第一条', chat)
    await send('第二条', chat)
    backend.send.mockImplementation((agent, { id }) => {
      notifyTurn('turn/started', id, 'inProgress', agent)
      notifyTurn('turn/completed', id, 'failed', agent)
      receive(agent, { id, result: { turn: { id, status: 'inProgress', items: [] } } })
    })
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(pending().map((item) => item.text)).toEqual(['第二条']))
    expect(pending()[0]?.error).toContain('队列已暂停')
    expect(methods()).toEqual(['turn/start'])
  })
})
