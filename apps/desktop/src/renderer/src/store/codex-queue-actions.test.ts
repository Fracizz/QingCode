import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserInput } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { currentSideChat, pendingSendKey, useCodex } from './codex'

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
// 会话列表刷新与队列无关，断言时略过。
const calls = () => backend.send.mock.calls.map(([, msg]) => msg).filter((msg) => msg.method !== 'thread/list')
const methods = () => calls().map((msg) => msg.method)

function receive(agent: AgentKind, msg: unknown) {
  for (const listener of backend.listeners) listener({ agent, targetId, seq: null, msg })
}

function notifyTurn(method: 'turn/started' | 'turn/completed', id: string, status: string) {
  receive('codex', { method, params: { threadId, turn: { id, status, items: [] } } })
}

describe('排队消息操作', () => {
  beforeEach(async () => {
    for (const session of Object.values(useCodex.getState().sessions)) {
      session.rpc.dispose()
      session.transport.dispose()
    }
    backend.send.mockReset()
    backend.send.mockImplementation((agent, { id, method }) => {
      const result = method === 'turn/start' ? { turn: { id, status: 'inProgress', items: [] } }
        : method === 'thread/start' ? { thread: { id: 'new-thread', status: { type: 'idle' }, turns: [] } }
          : method === 'thread/fork' ? { thread: { id: 'forked-thread', status: { type: 'idle' }, turns: [] } }
            : {}
      receive(agent, { id, result })
    })
    useCodex.setState({
      sessions: {}, pendingSends: {}, sideChats: {}, sending: false,
      currentTargetId: targetId, currentThreadId: threadId, currentAgent: 'codex', error: null, notice: null,
    })
    await useCodex.getState().ensureOpen(targetId, 'codex')
    notifyTurn('turn/started', 'active', 'inProgress')
  })

  it('把排队消息引导到当前一轮，并移出队列', async () => {
    const { send, steerPendingSend } = useCodex.getState()
    await send('第一条', chat)
    await send('补充', chat)
    expect(await steerPendingSend(chat, pending()[1]!.id)).toBe(true)
    expect(methods()).toEqual(['turn/steer'])
    expect(calls()[0]?.params).toMatchObject({ threadId, expectedTurnId: 'active' })
    expect(pending().map((item) => item.text)).toEqual(['第一条'])
  })

  it('编辑期间暂停自动发送，保存后替换正文并保留附件', async () => {
    const image = { type: 'image', url: 'data:image/png;base64,AA==' } as const
    await useCodex.getState().send('原文', { ...chat, input: [{ type: 'text', text: '原文', text_elements: [] }, image] })
    const id = pending()[0]!.id
    const release = useCodex.getState().holdPendingSend(chat, id)!
    expect(release).toBeTypeOf('function')
    notifyTurn('turn/completed', 'active', 'completed')
    await Promise.resolve()
    expect(methods()).toEqual([])
    expect(useCodex.getState().editPendingSend(chat, id, '新文')).toBe(true)
    expect(pending()[0]).toMatchObject({ text: '新文', input: [{ type: 'text', text: '新文' }, image] })
    release()
    await vi.waitFor(() => expect(pending()).toEqual([]))
    expect(methods()).toEqual(['turn/start'])
    expect(calls()[0]?.params.input).toMatchObject([{ type: 'text', text: '新文' }, image])
  })

  it('新会话开始：在新会话发送并切换过去', async () => {
    await useCodex.getState().send('另起', chat)
    expect(await useCodex.getState().sendPendingInNewThread(chat, pending()[0]!.id, 'start')).toBe(true)
    expect(methods().slice(0, 2)).toEqual(['thread/start', 'turn/start'])
    expect(calls()[1]?.params.threadId).toBe('new-thread')
    expect(pending()).toEqual([])
    expect(useCodex.getState().currentThreadId).toBe('new-thread')
  })

  it('新会话继续：在侧栏分叉到最后一个已结束的轮次，主会话不切换', async () => {
    await useCodex.getState().send('接着做', chat)
    const id = pending()[0]!.id
    expect(await useCodex.getState().sendPendingInNewThread(chat, id, 'continue')).toBe(false)
    expect(methods()).toEqual([])
    expect(pending()[0]?.error).toContain('还没有已结束的一轮')
    expect(currentSideChat(useCodex.getState())).toBeUndefined()

    useCodex.getState().removePendingSend(chat, id)
    await useCodex.getState().send('接着做', chat)
    notifyTurn('turn/completed', 'active', 'completed')
    await vi.waitFor(() => expect(methods()).toEqual(['turn/start']))
    notifyTurn('turn/started', 'second', 'inProgress')
    const input: UserInput[] = [
      { type: 'text', text: '分支里做', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AA==' },
    ]
    await useCodex.getState().send('分支里做', { ...chat, input })
    expect(await useCodex.getState().sendPendingInNewThread(chat, pending()[0]!.id, 'continue')).toBe(true)
    const fork = calls().find((msg) => msg.method === 'thread/fork')
    expect(fork?.params).toEqual({ threadId, lastTurnId: 'active' })
    expect(calls().at(-1)).toMatchObject({ method: 'turn/start', params: { threadId: 'forked-thread', input } })
    expect(pending()).toEqual([])
    expect(useCodex.getState().currentThreadId).toBe(threadId)
    expect(currentSideChat(useCodex.getState())).toMatchObject({
      threadId: 'forked-thread', parentThreadId: threadId, forked: true, open: true, busy: false,
    })

    useCodex.getState().closeSideChat()
    expect(currentSideChat(useCodex.getState())?.open).toBe(false)
    useCodex.getState().openSideChat()
    expect(currentSideChat(useCodex.getState())).toMatchObject({ threadId: 'forked-thread', open: true })

    receive('codex', { method: 'thread/closed', params: { threadId: 'forked-thread' } })
    expect(currentSideChat(useCodex.getState())?.expired).toBe(true)
    const reply = backend.send.getMockImplementation()
    backend.send.mockImplementation((agent, request) => {
      if (request.method === 'thread/resume') {
        receive(agent, { id: request.id, result: { thread: {
          id: 'forked-thread', status: { type: 'idle' }, turns: [{ id: 'active', status: 'completed', items: [] }],
        } } })
      } else reply?.(agent, request)
    })
    await useCodex.getState().restartSideChat()
    expect(calls().find((msg) => msg.method === 'thread/resume')?.params.threadId).toBe('forked-thread')
    expect(currentSideChat(useCodex.getState())).toMatchObject({ threadId: 'forked-thread', expired: false })
    expect(useCodex.getState().currentThreadId).toBe(threadId)
  })

  it('已有侧聊草稿时保留侧聊与排队消息', async () => {
    useCodex.getState().openSideChat()
    useCodex.getState().setSideDraft('侧聊草稿')
    await useCodex.getState().send('分支里做', chat)
    expect(await useCodex.getState().sendPendingInNewThread(chat, pending()[0]!.id, 'continue')).toBe(false)
    expect(methods()).toEqual([])
    expect(pending()[0]).toMatchObject({ text: '分支里做', error: '请先处理已有的侧边对话，再创建分支' })
    expect(currentSideChat(useCodex.getState())).toMatchObject({ draft: '侧聊草稿', open: true })
  })

  it('分支发送失败时在侧栏显示错误并保留原队列', async () => {
    notifyTurn('turn/completed', 'active', 'completed')
    notifyTurn('turn/started', 'second', 'inProgress')
    const reply = backend.send.getMockImplementation()
    backend.send.mockImplementation((agent, request) => {
      if (request.method === 'turn/start' && request.params.threadId === 'forked-thread') {
        receive(agent, { id: request.id, error: { code: -32603, message: '启动轮次失败' } })
      } else reply?.(agent, request)
    })
    await useCodex.getState().send('分支里做', chat)
    expect(await useCodex.getState().sendPendingInNewThread(chat, pending()[0]!.id, 'continue')).toBe(false)
    expect(pending()[0]).toMatchObject({ text: '分支里做', sending: false, error: expect.stringContaining('启动轮次失败') })
    expect(currentSideChat(useCodex.getState())).toMatchObject({
      threadId: 'forked-thread', open: true, busy: false, error: expect.stringContaining('启动轮次失败'),
    })
    expect(useCodex.getState().currentThreadId).toBe(threadId)
  })
})
