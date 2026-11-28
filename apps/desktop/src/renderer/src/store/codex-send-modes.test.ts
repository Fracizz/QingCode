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

const calls = () => backend.send.mock.calls.filter(([, msg]) => msg.method !== 'model/list')
const methods = () => calls().map(([, msg]) => msg.method)

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
    notifyTurn('turn/completed', calls()[0]![1].id, 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(calls().map(([, msg]) => msg.params.input)).toEqual([
      [{ type: 'text', text: '第一个', text_elements: [] }],
      [{ type: 'text', text: '最后一个', text_elements: [] }],
    ])
  })

  it('Codex 引导附带当前 turn ID，不抢占已有队列', async () => {
    const { send } = useCodex.getState()
    await send('等候', chat)
    expect(await send('补充要求', { ...chat, mode: 'steer' })).toBe(true)
    expect(methods()).toEqual(['turn/steer'])
    expect(calls()[0]?.[1].params.expectedTurnId).toBe('active')
    expect(pending().map((item) => item.text)).toEqual(['等候'])
  })

  it.each(['claude', 'pi'] as const)('%s 的输入框和排队消息都能引导', async (agent) => {
    const { send, ensureOpen, steerPendingSend } = useCodex.getState()
    const address = { ...chat, agent }
    await ensureOpen(targetId, agent)
    notifyTurn('turn/started', 'other-active', 'inProgress', agent)
    expect(await send('补充要求', { ...address, mode: 'steer' })).toBe(true)
    expect(await send('排队后引导', address)).toBe(true)
    const queue = () => useCodex.getState().pendingSends[pendingSendKey(address)] ?? []
    expect(await steerPendingSend(address, queue()[0]!.id)).toBe(true)
    expect(queue()).toEqual([])
    expect(calls()).toEqual(['补充要求', '排队后引导'].map((text) => [agent, expect.objectContaining({
      method: 'turn/steer', params: expect.objectContaining({
        expectedTurnId: 'other-active', clientUserMessageId: expect.any(String),
        input: [{ type: 'text', text, text_elements: [] }],
      }),
    })]))
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
    notifyTurn('turn/completed', calls().find(([, request]) => request.method === 'turn/start')![1].id, 'completed')
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

  const steer = (text: string) => useCodex.getState().send(text, { ...chat, mode: 'steer' })
  const view = () => useCodex.getState().sessions[sessionKey(targetId, 'codex')]?.state.threads[threadId]
  const userTexts = () => view()?.items.flatMap((item) => item.kind === 'user' ? [item.text] : [])

  /** turn/steer 回 error，其余请求照常成功；before 在回错误前执行。 */
  function failSteer(code: number, before?: () => void) {
    backend.send.mockImplementation((agent, { id, method }) => {
      if (method === 'turn/steer') {
        before?.()
        receive(agent, { id, error: { code, message: '引导失败原因' } })
      } else {
        receive(agent, { id, result: method === 'turn/start' ? { turn: { id, status: 'inProgress', items: [] } } : {} })
      }
    })
  }

  it('引导时轮次刚结束，按普通消息发送', async () => {
    notifyTurn('turn/completed', 'active', 'completed')
    expect(await steer('接着做')).toBe(true)
    expect(methods()).toEqual(['turn/start'])
    expect(userTexts()).toEqual(['接着做'])
    expect(useCodex.getState().error).toBeNull()
  })

  it('斜杠命令不引导，转入排队，本轮结束后发送', async () => {
    expect(await steer('/review 保留结论')).toBe(true)
    expect(methods()).toEqual([])
    expect(pending().map((item) => item.text)).toEqual(['/review 保留结论'])
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/start'])
  })

  it('本轮正在压缩上下文时转入排队', async () => {
    receive('codex', {
      method: 'item/started',
      params: { threadId, turnId: 'active', item: { type: 'contextCompaction', id: 'compact-1' } },
    })
    expect(await steer('压缩时补充')).toBe(true)
    expect(methods()).toEqual([])
    expect(pending().map((item) => item.text)).toEqual(['压缩时补充'])
  })

  it.each(['steer', 'immediate', 'queue'] as const)('手动压缩启动期间 %s 方式的消息排队', async (mode) => {
    // 轮次事件还没到时会话仍显示空闲；真实流程里队列由压缩持有，这里只核对没有引导或打断。
    useCodex.setState({ compacting: { [pendingSendKey(chat)]: true } })
    expect(await useCodex.getState().send('稍后处理', { ...chat, mode })).toBe(true)
    expect(methods()).toEqual([])
    expect(pending().map((item) => item.text)).toEqual(['稍后处理'])
    expect(useCodex.getState().error).toBeNull()
    useCodex.setState({ compacting: {} })
  })

  it('Agent 拒绝引导且本轮仍在运行时转入排队', async () => {
    failSteer(-32600)
    expect(await steer('补充要求')).toBe(true)
    expect(methods()).toEqual(['turn/steer'])
    expect(pending().map((item) => item.text)).toEqual(['补充要求'])
    expect(userTexts()).toEqual([])
    expect(useCodex.getState().notice).toBe('当前无法引导，消息已排队')
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/steer', 'turn/start'])
  })

  it('拒绝回包到达前轮次已结束时直接发送，且只保留一条消息', async () => {
    failSteer(-32600, () => notifyTurn('turn/completed', 'active', 'completed'))
    expect(await steer('赶在结束时')).toBe(true)
    expect(methods()).toEqual(['turn/steer', 'turn/start'])
    expect(userTexts()).toEqual(['赶在结束时'])
    expect(pending()).toEqual([])
  })

  it('引导结果未确认时保留草稿，不自动重发', async () => {
    failSteer(-32000)
    expect(await steer('不确定')).toBe(false)
    expect(methods()).toEqual(['turn/steer'])
    expect(pending()).toEqual([])
    expect(userTexts()).toEqual([])
  })

  it('排队消息的引导被拒绝时原样留在队列，本轮结束后照常发送', async () => {
    failSteer(-32602)
    await useCodex.getState().send('排队消息', chat)
    expect(await useCodex.getState().steerPendingSend(chat, pending()[0]!.id)).toBe(false)
    expect(pending()[0]).toMatchObject({ text: '排队消息', sending: false })
    expect(pending()[0]?.error).toBeUndefined()
    expect(useCodex.getState().notice).toBe('当前无法引导，消息继续排队')
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/steer', 'turn/start'])
  })

  it('引导排队消息时本轮被停止，暂停队列等用户确认', async () => {
    failSteer(-32602, () => notifyTurn('turn/completed', 'active', 'interrupted'))
    await useCodex.getState().send('排队消息', chat)
    expect(await useCodex.getState().steerPendingSend(chat, pending()[0]!.id)).toBe(false)
    expect(pending()[0]?.error).toContain('队列已暂停')
    expect(methods()).toEqual(['turn/steer'])
  })

  it('打断失败时消息留在队首并暂停', async () => {
    backend.send.mockImplementation((agent, { id, method }) => {
      receive(agent, method === 'turn/interrupt' ? { id, error: { code: -32603, message: '无法中断' } } : { id, result: {} })
    })
    await useCodex.getState().send('原队列', chat)
    expect(await useCodex.getState().send('优先修正', { ...chat, mode: 'immediate' })).toBe(true)
    expect(methods()).toEqual(['turn/interrupt'])
    expect(pending().map((item) => item.text)).toEqual(['优先修正', '原队列'])
    expect(pending()[0]?.error).toBe('打断未成功，消息已保留在队列')
    expect(userTexts()).toEqual([])
    // 本轮随后正常结束也不自动发送，等用户点继续。
    notifyTurn('turn/completed', 'active', 'completed')
    await Promise.resolve()
    expect(methods()).toEqual(['turn/interrupt'])
  })

  it('中断请求到达前轮次已自然结束时照常发送', async () => {
    backend.send.mockImplementation((agent, { id, method }) => {
      if (method === 'turn/interrupt') {
        notifyTurn('turn/completed', 'active', 'completed')
        receive(agent, { id, error: { code: -32600, message: 'no active turn' } })
      } else receive(agent, { id, result: { turn: { id, status: 'inProgress', items: [] } } })
    })
    expect(await useCodex.getState().send('优先修正', { ...chat, mode: 'immediate' })).toBe(true)
    expect(methods()).toEqual(['turn/interrupt', 'turn/start'])
    expect(pending()).toEqual([])
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
