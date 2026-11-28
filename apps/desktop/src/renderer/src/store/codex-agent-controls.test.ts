import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STEER_ECHO_GRACE_MS } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { getAccessSelection } from '../features/access/accessModel'
import { sessionKey } from '../lib/agents'
import { pendingSendKey, useCodex } from './codex'

type RpcRequest = { id: string; method?: string; params: Record<string, unknown>; result?: unknown }

const backend = vi.hoisted(() => ({
  listeners: new Set<(payload: unknown) => void>(),
  send: vi.fn<(agent: AgentKind, msg: RpcRequest) => void>(),
}))

vi.mock('../lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/backend')>(),
  call: async (method: string, params: { agent: AgentKind; msg: RpcRequest; method?: string }) => {
    if (method === 'codex.send') backend.send(params.agent, params.msg)
    if (method === 'server.req' && params.method === 'codex.open') return { lastSeq: 0, capabilities: { accessModes: true } }
    return { lastSeq: 0 }
  },
  on: (name: string, listener: (payload: unknown) => void) => {
    if (name === 'codex.recv') backend.listeners.add(listener)
    return () => backend.listeners.delete(listener)
  },
}))

const targetId = 'test-target'
let serial = 0
let threadId = ''
const chat = (agent: AgentKind = 'claude') => ({ targetId, threadId, agent })
const pending = (agent: AgentKind = 'claude', id = threadId) =>
  useCodex.getState().pendingSends[pendingSendKey({ targetId, agent, threadId: id })] ?? []
const view = (id = threadId, agent: AgentKind = 'claude') =>
  useCodex.getState().sessions[sessionKey(targetId, agent)]?.state.threads[id]
const calls = () => backend.send.mock.calls.map(([, msg]) => msg)
  .filter((msg) => msg.method && msg.method !== 'thread/list')
const methods = () => calls().map((msg) => msg.method)
const receive = (msg: unknown, agent: AgentKind = 'claude') => {
  for (const listener of backend.listeners) listener({ agent, targetId, seq: null, msg })
}
const notify = (method: string, params: Record<string, unknown>, agent: AgentKind = 'claude') =>
  receive({ method, params: { threadId, ...params } }, agent)
const turnNote = (method: 'turn/started' | 'turn/completed', id: string, status: string) =>
  notify(method, { turn: { id, status, items: [] } })
const userItem = (id: string, text = id) => ({ type: 'userMessage', id, clientId: id, content: [{ type: 'text', text }] })
const finished = (id: string, ...ids: string[]) => ({
  id, status: 'completed',
  items: ids.map((item) => item.startsWith('u') ? userItem(item) : { type: 'agentMessage', id: item, text: item }),
})

/** 默认回包；overrides 返回 undefined 时走默认。 */
function answer(overrides: (msg: RpcRequest) => { result?: unknown; error?: unknown } | undefined = () => undefined) {
  backend.send.mockImplementation((agent, msg) => {
    if (!msg.method) return
    const custom = overrides(msg)
    if (custom) return receive({ id: msg.id, ...custom }, agent)
    const result = msg.method === 'turn/start' ? { turn: { id: msg.id, status: 'inProgress', items: [] } }
      : msg.method === 'turn/steer' ? { turnId: msg.params.expectedTurnId }
        : msg.method === 'thread/list' ? { data: [], nextCursor: null }
          : {}
    receive({ id: msg.id, result }, agent)
  })
}

beforeEach(async () => {
  for (const session of Object.values(useCodex.getState().sessions)) {
    session.rpc.dispose()
    session.transport.dispose()
  }
  threadId = `thread-${++serial}`
  backend.send.mockReset()
  answer()
  useCodex.setState({
    sessions: {}, pendingSends: {}, sideChats: {}, sending: false, threadLists: {},
    currentTargetId: targetId, currentThreadId: threadId, currentAgent: 'claude', currentCwd: null, error: null, notice: null,
  })
  await useCodex.getState().ensureOpen(targetId, 'claude')
})

afterEach(() => { vi.useRealTimers() })

describe('撤回的引导', () => {
  const steer = async () => {
    turnNote('turn/started', 'active', 'inProgress')
    vi.useFakeTimers()
    expect(await useCodex.getState().send('补充要求', { ...chat(), mode: 'steer' })).toBe(true)
    return calls()[0]!.params.clientUserMessageId as string
  }
  const settle = () => vi.advanceTimersByTimeAsync(STEER_ECHO_GRACE_MS + 10)

  it('停止后没有回显的引导放回队列并暂停，不自动重发', async () => {
    await steer()
    turnNote('turn/completed', 'active', 'interrupted')
    expect(pending()).toEqual([])
    await settle()
    expect(pending()).toMatchObject([{ text: '补充要求', error: expect.stringContaining('未送达') }])
    expect(useCodex.getState().notice).toContain('未送达')
    await settle()
    expect(methods()).toEqual(['turn/steer'])
    // 用户确认后才发送。
    useCodex.getState().retryPendingSend(chat())
    await vi.advanceTimersByTimeAsync(10)
    expect(methods()).toEqual(['turn/steer', 'turn/start'])
  })

  it('未送达的引导排在原有队列前面', async () => {
    await steer()
    await useCodex.getState().send('排队的', chat())
    turnNote('turn/completed', 'active', 'interrupted')
    await settle()
    expect(pending().map((item) => item.text)).toEqual(['补充要求', '排队的'])
    expect(pending().every((item) => item.error)).toBe(true)
  })

  it('本轮结束前已回显的引导不入队', async () => {
    const clientId = await steer()
    notify('item/completed', { turnId: 'active', item: userItem(clientId, '补充要求') })
    turnNote('turn/completed', 'active', 'completed')
    await settle()
    expect(pending()).toEqual([])
  })

  it('进入下一轮处理的引导不算丢失', async () => {
    const clientId = await steer()
    turnNote('turn/completed', 'active', 'completed')
    turnNote('turn/started', 'next', 'inProgress')
    notify('item/completed', { turnId: 'next', item: userItem(clientId, '补充要求') })
    await settle()
    turnNote('turn/completed', 'next', 'completed')
    await settle()
    expect(pending()).toEqual([])
  })

  it('判定之后又收到回显时撤掉队列里的副本', async () => {
    const clientId = await steer()
    turnNote('turn/completed', 'active', 'interrupted')
    await settle()
    expect(pending()).toHaveLength(1)
    turnNote('turn/started', 'late', 'inProgress')
    notify('item/completed', { turnId: 'late', item: userItem(clientId, '补充要求') })
    expect(pending()).toEqual([])
  })

  it('从队列引导的消息被撤回后回到队列', async () => {
    turnNote('turn/started', 'active', 'inProgress')
    await useCodex.getState().send('先排队', chat())
    vi.useFakeTimers()
    expect(await useCodex.getState().steerPendingSend(chat(), pending()[0]!.id)).toBe(true)
    expect(pending()).toEqual([])
    turnNote('turn/completed', 'active', 'interrupted')
    await settle()
    expect(pending()).toMatchObject([{ text: '先排队', error: expect.stringContaining('未送达') }])
  })
})

describe('计划模式', () => {
  const address = () => chat()
  const selection = () => getAccessSelection(useCodex.getState().access, address())
  const choose = (mode: 'auto' | 'plan') => useCodex.getState().setAccessMode(address(), useCodex.getState().access.draftRevision, mode)
  const exitItem = (id: string, status: string) =>
    ({ type: 'dynamicToolCall', id, tool: 'ExitPlanMode', arguments: { plan: '方案' }, status })
  const ask = (requestId: string, itemId: string) => {
    notify('item/started', { turnId: 'active', item: exitItem(itemId, 'inProgress') })
    receive({ id: requestId, method: 'item/commandExecution/requestApproval', params: {
      threadId, turnId: 'active', itemId, command: 'ExitPlanMode {}',
    } })
  }
  const replies = () => backend.send.mock.calls.filter(([, msg]) => !msg.method)

  beforeEach(() => {
    turnNote('turn/started', 'active', 'inProgress')
    choose('auto')
    choose('plan')
  })

  it('只在用户批准后切回原档位，拒绝时保持计划模式', async () => {
    ask('first', 'plan-1')
    expect(replies()).toEqual([])
    useCodex.getState().respondApproval(address(), 'first', 'decline')
    expect(selection()).toBe('plan')
    ask('second', 'plan-2')
    useCodex.getState().respondApproval(address(), 'second', 'accept')
    expect(selection()).toBe('auto')
    expect(replies()).toHaveLength(2)
    turnNote('turn/completed', 'active', 'completed')
    await useCodex.getState().send('开始实现', address())
    expect(calls().at(-1)?.params).toMatchObject({ claudePermissionMode: 'auto' })
  })

  it('计划模式随轮次发送', async () => {
    turnNote('turn/completed', 'active', 'completed')
    await useCodex.getState().send('先给方案', address())
    expect(calls().at(-1)?.params).toMatchObject({ claudePermissionMode: 'plan' })
  })

  it('另一端批准时同步切回；本端批准过的条目不再覆盖新的选择', () => {
    notify('item/completed', { turnId: 'active', item: exitItem('remote', 'failed') })
    expect(selection()).toBe('plan')
    notify('item/completed', { turnId: 'active', item: exitItem('remote-ok', 'completed') })
    expect(selection()).toBe('auto')
    choose('plan')
    ask('mine', 'plan-local')
    useCodex.getState().respondApproval(address(), 'mine', 'accept')
    choose('plan')
    notify('item/completed', { turnId: 'active', item: exitItem('plan-local', 'completed') })
    expect(selection()).toBe('plan')
  })
})

describe('分支重发', () => {
  const input = [{ type: 'text' as const, text: '改过的问题', text_elements: [] }]
  const load = () => notify('thread/started', { thread: {
    id: threadId, status: { type: 'idle' }, turns: [finished('turn-1', 'u1', 'a1'), finished('turn-2', 'u2', 'a2')],
  } })
  const branch = { id: 'branch', status: { type: 'idle' }, turns: [] }
  const creating = (failTurn = false) => answer((msg) => {
    if (msg.method === 'thread/fork' || msg.method === 'thread/start') return { result: { thread: branch } }
    if (msg.method === 'turn/start' && failTurn) return { error: { code: -32000, message: '发送出错' } }
    return undefined
  })

  it('从上一轮分出新会话发送，原会话保留', async () => {
    load()
    creating()
    expect(await useCodex.getState().sendRevision(chat(), 'u2', input)).toBe(true)
    expect(methods()).toEqual(['thread/fork', 'turn/start'])
    expect(calls()[0]?.params).toEqual({ threadId, lastTurnId: 'turn-1' })
    expect(calls()[1]?.params).toMatchObject({ threadId: 'branch', input })
    expect(useCodex.getState().currentThreadId).toBe('branch')
    expect(useCodex.getState().notice).toContain('原会话保留')
    expect(view()?.items.map((item) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('修改第一条消息时开新会话', async () => {
    load()
    creating()
    expect(await useCodex.getState().sendRevision(chat(), 'u1', input)).toBe(true)
    expect(methods()).toEqual(['thread/start', 'turn/start'])
  })

  it('分支不带走单独提升的权限，计划模式保留', async () => {
    load()
    creating()
    const state = useCodex.getState
    state().setAccessMode(chat(), state().access.draftRevision, 'fullAccess')
    await state().sendRevision(chat(), 'u2', input)
    expect(calls().at(-1)?.params).not.toHaveProperty('claudePermissionMode')
    useCodex.setState({ currentThreadId: threadId })
    state().setAccessMode(chat(), state().access.draftRevision, 'plan')
    answer((msg) => msg.method === 'thread/fork' ? { result: { thread: { ...branch, id: 'branch-2' } } } : undefined)
    await state().sendRevision(chat(), 'u2', input)
    expect(calls().at(-1)?.params).toMatchObject({ threadId: 'branch-2', claudePermissionMode: 'plan' })
  })

  it('新会话建好但发送失败时，消息留在新会话的队列里', async () => {
    load()
    creating(true)
    expect(await useCodex.getState().sendRevision(chat(), 'u2', input)).toBe(false)
    expect(pending('claude', 'branch')).toMatchObject([{ text: '改过的问题', error: expect.any(String) }])
    expect(methods()).toEqual(['thread/fork', 'turn/start'])
  })

  it('运行中或轮次中间的消息不能分支', async () => {
    load()
    turnNote('turn/started', 'active', 'inProgress')
    expect(await useCodex.getState().sendRevision(chat(), 'u2', input)).toBe(false)
    turnNote('turn/completed', 'active', 'completed')
    expect(await useCodex.getState().sendRevision(chat(), 'a2', input)).toBe(false)
    expect(methods()).toEqual([])
  })
})

describe('文件回滚、后台任务与计划清单', () => {
  const idle = () => notify('thread/started', { thread: { id: threadId, status: { type: 'idle' }, turns: [] } })

  it('回滚按调用方给的 dryRun 发送，运行中拒绝', async () => {
    idle()
    answer((msg) => msg.method === 'qingcode/files/rewind'
      ? { result: { canRewind: true, filesChanged: ['a.ts'], insertions: 1, deletions: 2 } } : undefined)
    await expect(useCodex.getState().rewindFiles(chat(), 'turn-1', true)).resolves.toMatchObject({ filesChanged: ['a.ts'] })
    expect(calls().map((msg) => msg.params.dryRun)).toEqual([true])
    await useCodex.getState().rewindFiles(chat(), 'turn-1', false)
    expect(calls().map((msg) => msg.params.dryRun)).toEqual([true, false])
    turnNote('turn/started', 'active', 'inProgress')
    await expect(useCodex.getState().rewindFiles(chat(), 'turn-1', true)).rejects.toThrow('请先停止当前轮次')
    await expect(useCodex.getState().rewindFiles(chat('codex'), 'turn-1', true)).rejects.toThrow('不支持回滚')
    expect(calls()).toHaveLength(2)
  })

  it('读取与停止后台任务；停止失败时提示并重读列表', async () => {
    idle()
    const task = { id: 'build', type: 'local_bash', description: '构建' }
    let fail = false
    answer((msg) => {
      if (msg.method === 'qingcode/backgroundTasks/list') return { result: { tasks: fail ? [] : [task] } }
      if (msg.method === 'qingcode/backgroundTasks/stop' && fail) return { error: { code: -32602, message: '该会话没有运行中的后台任务' } }
      return undefined
    })
    await useCodex.getState().refreshBackgroundTasks(chat())
    expect(view()?.backgroundTasks).toEqual([task])
    expect(await useCodex.getState().stopBackgroundTask(chat(), 'build')).toBe(true)
    fail = true
    expect(await useCodex.getState().stopBackgroundTask(chat(), 'build')).toBe(false)
    expect(useCodex.getState().error).toContain('后台任务')
    await vi.waitFor(() => expect(view()?.backgroundTasks).toEqual([]))
    await useCodex.getState().refreshBackgroundTasks(chat('codex'))
    expect(backend.send.mock.calls.some(([agent, msg]) => agent === 'codex' && msg.method?.startsWith('qingcode/'))).toBe(false)
  })

  it('打开会话时到更早的页里补读清单', async () => {
    const plan = { explanation: null, plan: [{ step: '读代码', status: 'inProgress' }] }
    answer((msg) => {
      if (msg.method === 'thread/resume') return { result: { thread: { id: threadId, status: { type: 'idle' }, turns: [] } } }
      if (msg.method !== 'thread/turns/list') return undefined
      return { result: msg.params.itemsView === 'notLoaded'
        ? { data: [{ id: 'old', status: 'completed', items: [], plan }], nextCursor: null }
        : { data: [finished('recent', 'u9')], nextCursor: 'older' } }
    })
    useCodex.setState({ currentThreadId: null })
    await useCodex.getState().openThread(threadId, 'claude')
    await vi.waitFor(() => expect(view()?.plan?.steps).toEqual([{ step: '读代码', status: 'inProgress' }]))
    // 只补清单，不把更早的消息装进界面。
    expect(view()?.items.map((item) => item.id)).toEqual(['u9'])
  })
})
