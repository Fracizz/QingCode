import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_THREAD_ID } from '@qn/codex-client'
import { sessionKey } from '../lib/agents'
import { composerDraftKey, pendingSendKey, useCodex } from './codex'
import { useModels } from './models'

const { callMock, listeners } = vi.hoisted(() => ({
  callMock: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))

vi.mock('../lib/backend', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    call: callMock,
    on: (name: string, cb: (payload: unknown) => void) => {
      const bucket = listeners.get(name) ?? new Set<(payload: unknown) => void>()
      bucket.add(cb)
      listeners.set(name, bucket)
      return () => bucket.delete(cb)
    },
  }
})

type CallParams = { method?: string; agent?: string; msg?: { id?: number; method?: string; params?: { cursor?: string | null } } }

const emitRecv = (msg: unknown, agent = 'codex'): void => {
  for (const cb of [...(listeners.get('codex.recv') ?? [])]) {
    cb({ targetId: 'local', agent, seq: null, msg })
  }
}

/** 假 backend：codex.send 用事件回 JSON-RPC 响应，其余方法直接给结果。 */
async function fakeCall(method: string, params?: CallParams): Promise<unknown> {
  if (method === 'server.req') {
    if (params?.method === 'codex.open') return { initialize: {}, lastSeq: 0 }
    if (params?.method === 'codex.attach') return { lastSeq: 0, truncated: false }
    return {}
  }
  if (method === 'codex.send') {
    const msg = params?.msg
    const agent = params?.agent ?? 'codex'
    queueMicrotask(() => {
      const result =
        msg?.method === 'thread/start'
          ? { thread: { id: 't1', status: { type: 'idle' }, turns: [] } }
          : msg?.method === 'turn/start'
            ? { turn: { id: 'turn1', status: 'inProgress', items: [] } }
            : { data: [] }
      emitRecv({ id: msg?.id, result }, agent)
    })
    return {}
  }
  return {}
}

const viewItems = (threadId: string) =>
  useCodex.getState().sessions[sessionKey('local', 'codex')]?.state.threads[threadId]?.items ?? []

beforeEach(() => {
  listeners.clear()
  callMock.mockReset()
  callMock.mockImplementation(fakeCall)
  useCodex.setState({
    sessions: {},
    sideChats: {},
    pendingSends: {},
    agents: {},
    currentTargetId: 'local',
    currentCwd: null,
    currentThreadId: null,
    currentAgent: 'codex',
    threads: [],
    sending: false,
    error: null,
    notice: null,
  })
})

describe('输入框草稿标识', () => {
  const key = () => composerDraftKey(useCodex.getState())

  it('连续新建会话时使用不同的草稿标识', () => {
    const first = key()
    useCodex.getState().startDraft('codex')
    expect(key()).not.toBe(first)
  })

  it('切换 Agent 时保留输入草稿，只重置权限选择', () => {
    const first = key()
    const accessRevision = useCodex.getState().access.draftRevision
    useCodex.getState().setDraftAgent('claude')
    expect(useCodex.getState().currentAgent).toBe('claude')
    expect(useCodex.getState().access.draftRevision).toBeGreaterThan(accessRevision)
    expect(key()).toBe(first)
    useCodex.getState().setDraftAgent('codex')
    expect(key()).toBe(first)
  })

  it('切回已打开的会话时恢复其草稿标识', () => {
    useCodex.setState({ currentThreadId: 'first' })
    const first = key()
    useCodex.setState({ currentThreadId: 'second' })
    expect(key()).not.toBe(first)
    useCodex.getState().startDraft('codex')
    expect(key()).not.toBe(first)
    useCodex.setState({ currentThreadId: 'first' })
    expect(key()).toBe(first)
  })
})

it('可在发送首条消息前启动 pi，首轮沿用该会话和所选模型', async () => {
  const originalModels = useModels.getState()
  const key = sessionKey('local', 'pi')
  const model = { id: 'provider/model', model: 'provider/model', displayName: '测试模型' }
  const listRequestIds: number[] = []
  callMock.mockImplementation((method: string, params?: CallParams) => {
    const msg = params?.msg
    if (method === 'codex.send' && msg?.method === 'model/list' && msg.id !== undefined) {
      listRequestIds.push(msg.id)
      return Promise.resolve({})
    }
    return fakeCall(method, params)
  })
  const store = useCodex.getState
  store().startDraft('pi')
  const onCreated = vi.fn()
  const requests = () => callMock.mock.calls.flatMap(([method, params]) => method === 'codex.send' ? [params.msg] : [])
  try {
    expect(await store().ensureOpen('local', 'pi')).toBe(true)
    const rpc = store().sessions[key].rpc
    const earlyList = useModels.getState().load('local', 'pi', rpc)

    await store().newThread('pi', onCreated)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('t1')
    expect(store().currentThreadId).toBe('t1')
    expect(requests().some((msg) => msg.method === 'turn/start')).toBe(false)

    const currentList = useModels.getState().load('local', 'pi', rpc, true)
    expect(listRequestIds).toHaveLength(2)
    emitRecv({ id: listRequestIds[1], result: { data: [model] } }, 'pi')
    await currentList
    emitRecv({ id: listRequestIds[0], result: { data: [] } }, 'pi')
    await earlyList

    useModels.getState().setPrefs('pi', { model: model.model })
    expect(await store().send('首条消息')).toBe(true)
    expect(requests().filter((msg) => msg.method === 'thread/start')).toHaveLength(1)
    expect(requests()).toContainEqual(expect.objectContaining({
      method: 'turn/start',
      params: expect.objectContaining({ threadId: 't1', model: model.model }),
    }))
  } finally {
    useModels.setState(originalModels)
  }
})

it('桌面打开只加载最近页，向前加载时保留当前选中的会话', async () => {
  const cursors: (string | null | undefined)[] = []
  callMock.mockImplementation((method: string, params?: CallParams) => {
    const msg = params?.msg
    if (method !== 'codex.send' || !msg) return fakeCall(method, params)
    if (msg.method === 'thread/resume') {
      queueMicrotask(() => emitRecv({ id: msg.id, result: { thread: { id: 'history', status: { type: 'idle' }, turns: [] } } }))
    } else if (msg.method === 'thread/turns/list') {
      const cursor = msg.params?.cursor
      cursors.push(cursor)
      const id = cursor ? 'older' : 'recent'
      const turn = { id, status: 'completed', items: [{ id, type: 'agentMessage', text: id }] }
      queueMicrotask(() => emitRecv({ id: msg.id, result: { data: [turn], nextCursor: cursor ? null : 'previous' } }))
    } else {
      return fakeCall(method, params)
    }
    return Promise.resolve({})
  })
  const store = useCodex.getState
  await store().openThread('history')
  expect(store().currentThreadId).toBe('history')
  expect(cursors).toEqual([null])
  expect(viewItems('history').map(({ id }) => id)).toEqual(['recent'])
  const captureScroll = vi.fn()
  await store().loadEarlierHistory(captureScroll)
  expect(captureScroll).toHaveBeenCalledOnce()
  expect(cursors).toEqual([null, 'previous'])
  expect(store().currentThreadId).toBe('history')
  expect(viewItems('history').map(({ id }) => id)).toEqual(['older', 'recent'])
})

describe('发送时的乐观用户消息', () => {
  it('不等待 codex.open 回包就先显示气泡', async () => {
    const gate: { resolve?: (value: unknown) => void } = {}
    const open = new Promise<unknown>((resolve) => {
      gate.resolve = resolve
    })
    callMock.mockImplementation((method: string, params?: CallParams) =>
      method === 'server.req' && params?.method === 'codex.open' ? open : fakeCall(method, params),
    )

    const sending = useCodex.getState().send('你好')
    // 此刻 codex.open 还挂在网络上，气泡必须已经在草稿线程里。
    expect(viewItems(DRAFT_THREAD_ID)).toMatchObject([{ kind: 'user', text: '你好', pending: true }])
    expect(useCodex.getState().sending).toBe(true)
    expect(useCodex.getState().sendingMessage?.key).toBe(pendingSendKey({ targetId: 'local', agent: 'codex', threadId: DRAFT_THREAD_ID }))

    gate.resolve?.({ initialize: {}, lastSeq: 0 })
    await expect(sending).resolves.toBe(true)
    expect(viewItems('t1')).toMatchObject([{ kind: 'user', text: '你好' }])
    expect(useCodex.getState().sendingMessage).toBeNull()
  })

  it('服务端回显到达后替换占位，不会留下重复气泡', async () => {
    await expect(useCodex.getState().send('你好')).resolves.toBe(true)
    expect(viewItems('t1')).toHaveLength(1)
    emitRecv({
      method: 'item/completed',
      params: {
        threadId: 't1',
        item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '你好' }] },
      },
    })
    expect(viewItems('t1').map((item) => item.id)).toEqual(['u1'])
  })

  it('请求子代理时只发送一轮，并把委派请求放在这一轮的正文中', async () => {
    await expect(useCodex.getState().send('核对文档', { delegate: true })).resolves.toBe(true)
    const turns = callMock.mock.calls
      .filter(([method, params]) => method === 'codex.send' && params?.msg?.method === 'turn/start')
    expect(turns).toHaveLength(1)
    expect(turns[0]?.[1].msg.params.input).toEqual([
      { type: 'text', text: expect.stringMatching(/^核对文档\n\n请.*子代理/), text_elements: [] },
    ])
  })

  it('发送失败时撤回占位、复位 sending 并返回 false', async () => {
    callMock.mockImplementation(async (method: string, params?: CallParams) => {
      if (method === 'codex.send' && params?.msg?.method === 'turn/start') throw new Error('turn 失败')
      return fakeCall(method, params)
    })
    await expect(useCodex.getState().send('你好')).resolves.toBe(false)
    expect(useCodex.getState().sending).toBe(false)
    expect(useCodex.getState().sendingMessage).toBeNull()
    expect(viewItems('t1').filter((item) => item.kind === 'user')).toEqual([])
  })
})

describe.each(['codex', 'claude', 'pi'] as const)('%s 侧边对话', (agent) => {
  it('首次发送才开临时会话，切换主会话后能找回侧聊并独立结束', async () => {
    callMock.mockImplementation((method: string, params?: CallParams) =>
      params?.method === 'codex.open'
        ? Promise.resolve({ initialize: {}, lastSeq: 0, capabilities: { ephemeralNoTools: true } })
        : fakeCall(method, params))
    useCodex.setState({ currentThreadId: 'parent', currentCwd: '/project', currentAgent: agent, sideChats: {} })
    const store = useCodex.getState
    store().openSideChat('一段引用')
    const owner = JSON.stringify(['local', '/project', agent, 'parent'])
    expect(callMock).not.toHaveBeenCalled()
    await store().sendSide(store().sideChats[owner]!.draft, 'queue')
    expect(store().currentThreadId).toBe('parent')
    expect(store().sideChats[owner]).toMatchObject({ threadId: 't1', draft: '' })
    expect(callMock.mock.calls.map(([, params]) => params)).toContainEqual(expect.objectContaining({
      agent, msg: expect.objectContaining({ method: 'thread/start', params: { cwd: '/project', ephemeral: true } }),
    }))
    store().setSideDraft('追问')
    store().closeSideChat()
    useCodex.setState({ currentThreadId: 'other' })
    store().openSideChat()
    expect(Object.values(store().sideChats).find(chat => chat.open)?.threadId).toBeNull()
    useCodex.setState({ currentThreadId: 'parent' })
    store().openSideChat()
    expect(store().sideChats[owner]).toMatchObject({ threadId: 't1', draft: '追问' })
    emitRecv({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed', items: [] } } }, agent)
    await store().sendSide('追问', 'queue')
    expect(callMock.mock.calls.filter(([, params]) => params?.msg?.method === 'thread/start')).toHaveLength(1)
    expect(callMock.mock.calls.filter(([, params]) => params?.msg?.method === 'turn/start')).toHaveLength(2)
    emitRecv({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed', items: [] } } }, agent)
    await store().endSideChat()
    expect(store().sessions[sessionKey('local', agent)]?.state.threads.t1).toBeUndefined()
    expect(store().sideChats[owner]).toBeUndefined()
    expect(Object.keys(store().sideChats)).toHaveLength(1)
  })
})

it('旧 Pi 服务缺少无工具能力时保留草稿并显示升级提示', async () => {
  useCodex.setState({ currentThreadId: 'parent', currentAgent: 'pi' })
  const store = useCodex.getState
  store().openSideChat('片段')
  const draft = Object.values(store().sideChats)[0]!.draft
  await store().sendSide(draft, 'queue')
  expect(Object.values(store().sideChats)[0]).toMatchObject({ draft, threadId: null, error: expect.stringContaining('升级') })
  expect(callMock.mock.calls.some(([, params]) => params?.msg?.method === 'thread/start')).toBe(false)
})

it('服务端关闭临时会话后保留摘录，重新开始时继续使用同一主会话', async () => {
  const store = useCodex.getState
  useCodex.setState({ currentThreadId: 'parent' })
  store().openSideChat('一段摘录')
  const draft = Object.values(store().sideChats)[0]!.draft
  await store().sendSide(draft, 'queue')
  emitRecv({ method: 'thread/closed', params: { threadId: 't1' } })
  expect(Object.values(store().sideChats)[0]?.expired).toBe(true)
  await store().restartSideChat()
  expect(Object.values(store().sideChats)[0]).toMatchObject({ threadId: null, expired: false, draft })
  expect(store().currentThreadId).toBe('parent')
})

it('重开临时侧聊后按原顺序保留队列，用户确认后才发送', async () => {
  const store = useCodex.getState
  useCodex.setState({ currentThreadId: 'parent' })
  store().openSideChat()
  await store().sendSide('正在进行的消息', 'queue')
  await store().sendSide('排队一', 'queue')
  await store().sendSide('排队二', 'queue')
  emitRecv({ method: 'thread/closed', params: { threadId: 't1' } })
  const oldAddress = { targetId: 'local', agent: 'codex', threadId: 't1' } as const
  expect(store().pendingSends[pendingSendKey(oldAddress)]?.map((item) => item.text)).toEqual(['排队一', '排队二'])
  store().retryPendingSend(oldAddress)
  await store().endSideChat()
  expect(Object.values(store().sideChats)[0]?.expired).toBe(true)

  callMock.mockImplementation(async (method: string, params?: CallParams) => {
    if (params?.msg?.method === 'thread/start') {
      emitRecv({ id: params.msg.id, result: { thread: { id: 't2', status: { type: 'idle' }, turns: [] } } })
      return {}
    }
    return fakeCall(method, params)
  })
  await store().restartSideChat()
  expect(Object.values(store().sideChats)[0]).toMatchObject({ threadId: 't2', expired: false })
  expect(store().pendingSends[pendingSendKey(oldAddress)]).toBeUndefined()
  const address = { ...oldAddress, threadId: 't2' }
  const queue = () => store().pendingSends[pendingSendKey(address)]
  expect(queue()).toMatchObject([{ text: '排队一', error: expect.stringContaining('继续发送') }, { text: '排队二' }])
  const turnRequests = () => callMock.mock.calls.filter(([, params]) => params?.msg?.method === 'turn/start')
  expect(turnRequests()).toHaveLength(1)
  store().retryPendingSend(address)
  await vi.waitFor(() => expect(queue()).toMatchObject([{ text: '排队二' }]))
  expect(turnRequests()).toHaveLength(2)
  expect(turnRequests()[1]?.[1].msg.params).toMatchObject({ threadId: 't2', input: [{ text: '排队一' }] })
})

it('运行中的侧聊保护主会话，结束后先释放侧聊再删除主会话', async () => {
  const store = useCodex.getState
  useCodex.setState({ currentThreadId: 'parent' })
  store().openSideChat()
  await store().sendSide('侧聊消息', 'queue')
  const requests = () => callMock.mock.calls.map(([, params]) => params?.msg?.method)
  await expect(store().deleteThread('parent', 'codex')).resolves.toBe(false)
  await expect(store().archiveThread('parent', 'codex')).resolves.toBe(false)
  expect(store().notice).toContain('请先停止侧聊')
  expect(requests()).not.toContain('thread/delete')
  expect(requests()).not.toContain('thread/archive')
  expect(store().currentThreadId).toBe('parent')

  emitRecv({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn1', status: 'completed', items: [] } } })
  await expect(store().deleteThread('parent', 'codex')).resolves.toBe(true)
  expect(requests().filter((method) => method === 'thread/unsubscribe' || method === 'thread/delete'))
    .toEqual(['thread/unsubscribe', 'thread/delete'])
  expect(store().sideChats).toEqual({})
  expect(store().currentThreadId).toBeNull()
})

it('从全部会话打开侧聊时沿用主会话的工作目录', () => {
  useCodex.setState({
    currentThreadId: 'parent', currentCwd: null,
    threads: [{ id: 'parent', agent: 'codex', cwd: '/work/project', title: '会话', preview: '', updatedAt: 0 }],
  })
  useCodex.getState().openSideChat('摘录')
  expect(Object.values(useCodex.getState().sideChats)[0]?.cwd).toBe('/work/project')
})

describe('打开历史会话', () => {
  it('回包丢失时超时报错并释放打开状态，可再次点击', async () => {
    vi.useFakeTimers()
    try {
      // 旧版 server 丢弃超长 thread/resume 回包：永远不回。
      callMock.mockImplementation((method: string, params?: CallParams) =>
        method === 'codex.send' && params?.msg?.method === 'thread/resume' ? Promise.resolve({}) : fakeCall(method, params),
      )
      const opening = useCodex.getState().openThread('old')
      await vi.advanceTimersByTimeAsync(0)
      expect(useCodex.getState().openingThread?.threadId).toBe('old')

      await vi.advanceTimersByTimeAsync(30_000)
      await opening
      expect(useCodex.getState().openingThread).toBeNull()
      expect(useCodex.getState().error).toContain('打开会话超时')
      expect(useCodex.getState().currentThreadId).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
