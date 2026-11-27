import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_THREAD_ID, type UserInput } from '@qn/codex-client'
import { defaultAppSettings } from '../features/settings/settingsModel'
import { useSettings } from '../features/settings/settingsStore'
import { sessionKey } from '../lib/agents'
import { applyThreadPrefs } from '../lib/threadPrefs'
import { composerDraftKey, currentChatKey, currentSideApprovals, currentThreadApprovals, currentThreads, pendingSendKey, threadListFor, useCodex } from './codex'
import { useModels } from './models'
import { useTargets } from './targets'
import { useThreadPrefs } from './threadPrefs'

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

type CallParams = {
  method?: string
  agent?: string
  targetId?: string
  params?: { agent?: string }
  msg?: { id?: number; method?: string; params?: { cursor?: string | null; cwd?: string; archived?: boolean; threadId?: string } }
}

const emitRecv = (msg: unknown, agent = 'codex', targetId = 'local'): void => {
  for (const cb of [...(listeners.get('codex.recv') ?? [])]) {
    cb({ targetId, agent, seq: null, msg })
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
      emitRecv({ id: msg?.id, result }, agent, params?.targetId)
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
  useThreadPrefs.setState({ byTarget: {} })
  useCodex.setState({
    sessions: {},
    sideChats: {},
    pendingSends: {},
    agents: {},
    currentTargetId: 'local',
    currentCwd: null,
    currentThreadId: null,
    currentAgent: 'codex',
    openingThread: null,
    threadLists: {},
    sending: false,
    error: null,
    notice: null,
  })
})

describe('发送修订', () => {
  const chat = { targetId: 'local', agent: 'codex', threadId: 'revision-source' } as const
  const destination = 'revision-destination'
  const input: UserInput[] = [{ type: 'text', text: '修订内容', text_elements: [] }, { type: 'localImage', path: '/project/image.png' }]
  const makeTurn = (id: string, itemId: string, text: string) => ({
    id, status: 'completed', items: [{ id: itemId, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] }],
  })
  const prior = makeTurn('prior-turn', 'prior-message', '保留的历史')
  const original = makeTurn('original-turn', 'original-message', '原来的消息')
  const later = makeTurn('later-turn', 'later-message', '原会话后续消息')
  const thread = (id: string, turns: ReturnType<typeof makeTurn>[]) => ({ id, cwd: '/project', status: { type: 'idle' }, turns })
  const sent = () => callMock.mock.calls.filter(([method]) => method === 'codex.send').map(([, params]) => params.msg)

  beforeEach(async () => {
    useCodex.setState({ currentCwd: '/project', currentThreadId: chat.threadId })
    await useCodex.getState().ensureOpen(chat.targetId, chat.agent)
    emitRecv({ method: 'thread/started', params: { thread: thread(chat.threadId, [prior, original, later]) } })
  })

  it.each([false, true])('继承修订前的历史并仅发送到分支（源历史分页 %s）', async (paginated) => {
    if (paginated) {
      const key = sessionKey(chat.targetId, chat.agent)
      const session = useCodex.getState().sessions[key]!
      const source = session.state.threads[chat.threadId]!
      useCodex.setState((state) => ({ sessions: { ...state.sessions, [key]: { ...session, state: { threads: {
        ...session.state.threads,
        [chat.threadId]: { ...source, turns: source.turns?.slice(1), items: source.items.slice(1), historyCursor: { turns: 'earlier' } },
      } } } } }))
    }
    callMock.mockImplementation((method: string, params?: CallParams) => {
      const msg = params?.msg
      if (method !== 'codex.send' || !msg) return fakeCall(method, params)
      let result
      switch (msg.method) {
        case 'thread/fork':
        case 'thread/read': result = { thread: thread(destination, []) }; break
        case 'thread/turns/list': result = { data: [prior], nextCursor: null }; break
        case 'turn/start': result = { turn: { id: 'revised-turn', status: 'inProgress', items: [] } }; break
        default: return fakeCall(method, params)
      }
      emitRecv({ id: msg.id, result })
      return Promise.resolve({})
    })

    expect(await useCodex.getState().sendRevision(chat, 'original-message', input)).toBe(true)
    expect(sent().find((msg) => msg.method === 'thread/fork')?.params).toEqual({
      threadId: chat.threadId, lastTurnId: 'prior-turn', excludeTurns: true,
    })
    expect(sent().filter((msg) => msg.method === 'turn/start')).toMatchObject([{ params: { threadId: destination, input } }])
    expect(useCodex.getState().currentThreadId).toBe(destination)
    expect(viewItems(destination).map((item) => item.kind === 'user' && item.text)).toEqual(['保留的历史', '修订内容'])
    expect(viewItems(chat.threadId).map((item) => item.id)).toContain('later-message')
    expect(useThreadPrefs.getState().byTarget.local?.revisionTurns).toMatchObject({ [`codex:${destination}`]: 'revised-turn' })
  })

  it('修订第一条消息时从原工作目录新建，发送失败后留在原会话', async () => {
    callMock.mockImplementation((method: string, params?: CallParams) => {
      const msg = params?.msg
      if (method !== 'codex.send' || !msg) return fakeCall(method, params)
      if (msg.method === 'thread/read') emitRecv({ id: msg.id, result: { thread: thread(chat.threadId, []) } })
      else if (msg.method === 'thread/start') emitRecv({ id: msg.id, result: { thread: thread(destination, []) } })
      else if (msg.method === 'turn/start') emitRecv({ id: msg.id, error: { code: -32603, message: '发送失败' } })
      else return fakeCall(method, params)
      return Promise.resolve({})
    })

    expect(await useCodex.getState().sendRevision(chat, 'prior-message', input)).toBe(false)
    expect(sent().find((msg) => msg.method === 'thread/start')?.params).toEqual({ cwd: '/project' })
    expect(sent().some((msg) => msg.method === 'thread/fork')).toBe(false)
    expect(useCodex.getState()).toMatchObject({ currentThreadId: chat.threadId, error: expect.stringContaining('发送失败') })
    expect(viewItems(chat.threadId).map((item) => item.id)).toEqual(['prior-message', 'original-message', 'later-message'])
    expect(viewItems(destination)).toEqual([])
    expect(useThreadPrefs.getState().byTarget.local?.revisionTurns?.[`codex:${destination}`]).toBeUndefined()
  })
})

describe('归档会话', () => {
  type HistoryThread = {
    id: string
    cwd: string
    updatedAt: number
    status?: { type: 'active' | 'idle' }
  }

  const oldThread = (id: string): HistoryThread => ({ id, cwd: '/work', updatedAt: Date.now() / 1000 - 2 * 86400 })

  function mockHistory(codex: HistoryThread[], claude: HistoryThread[], archived: HistoryThread[] = []) {
    callMock.mockImplementation(async (method: string, params?: CallParams) => {
      const msg = params?.msg
      const agent = params?.agent ?? 'codex'
      let result: unknown
      if (msg?.method === 'thread/list') {
        result = { data: agent === 'codex' ? (msg.params?.archived ? archived : codex) : agent === 'claude' ? claude : [] }
      } else if (msg?.method === 'thread/unarchive' || msg?.method === 'thread/archive') {
        const [from, to] = msg.method === 'thread/unarchive' ? [archived, codex] : [codex, archived]
        const index = from.findIndex(({ id }) => id === msg.params?.threadId)
        if (index >= 0) to.push(...from.splice(index, 1))
        result = {}
      } else {
        return fakeCall(method, params)
      }
      queueMicrotask(() => emitRecv({ id: msg.id, result }, agent, params?.targetId))
      return {}
    })
  }

  it('同一列表可恢复 Codex 原生归档与 Claude 本地归档', async () => {
    const store = useCodex.getState
    mockHistory([], [oldThread('claude-old'), oldThread('claude-active')], [oldThread('codex-old')])
    useCodex.setState({ currentThreadId: 'claude-old', currentAgent: 'claude' })
    await expect(store().archiveThread('claude-old', 'claude')).resolves.toBe(true)
    expect(store().currentThreadId).toBeNull()

    const { threads, error } = await store().listArchivedThreads('local')
    expect(error).toBeNull()
    expect(threads.map(({ id }) => id).sort()).toEqual(['claude-old', 'codex-old'])
    for (const thread of threads) await store().restoreThread('local', thread)

    expect((await store().listArchivedThreads('local')).threads).toEqual([])
    expect(callMock.mock.calls.filter(([, params]) => params?.msg?.method === 'thread/unarchive')
      .map(([, { agent, msg }]) => [agent, msg.params.threadId])).toEqual([['codex', 'codex-old']])
    const prefs = useThreadPrefs.getState().byTarget.local
    expect(prefs?.restoredAt).toMatchObject({ 'codex:codex-old': expect.any(Number), 'claude:claude-old': expect.any(Number) })
    expect(applyThreadPrefs(threads, prefs)).toHaveLength(2)
  })

  it('自动归档在设置保存后检查本机，跳过当前、置顶和仍在运行的会话', async () => {
    const settingsBefore = useSettings.getState()
    const targetsBefore = useTargets.getState()
    useThreadPrefs.getState().setPinned('local', 'codex:pinned', true)
    mockHistory([
      oldThread('old'), oldThread('open'), oldThread('pinned'),
      { ...oldThread('running'), status: { type: 'active' } },
    ], [oldThread('claude-old')])
    useCodex.setState({ currentThreadId: 'open' })
    useSettings.setState({ loaded: true, saving: false, settings: defaultAppSettings() })
    useTargets.setState({ states: { local: { id: 'local', state: 'ready' }, remote: { id: 'remote', state: 'ready' } } })
    const stop = useCodex.getState().init()
    try {
      const settings = defaultAppSettings()
      settings.general.autoArchiveDays = 1
      useSettings.setState({ settings, saving: true })
      expect(callMock).not.toHaveBeenCalled()
      useSettings.setState({ saving: false })
      await vi.waitFor(() => {
        expect(useThreadPrefs.getState().byTarget.local?.hidden['claude:claude-old']).toBe(true)
        const calls = callMock.mock.calls.filter(([, params]) => params?.msg?.method === 'thread/archive')
        expect(calls.map(([, { targetId, msg }]) => [targetId, msg.params.threadId])).toEqual([['local', 'old']])
      })
      expect(useCodex.getState().currentThreadId).toBe('open')
    } finally {
      stop()
      useSettings.setState(settingsBefore)
      useTargets.setState(targetsBefore)
    }
  })
})

it('恢复的项目在当前连接就绪后加载会话', () => {
  const stop = useCodex.getState().init()
  const refresh = vi.spyOn(useCodex.getState(), 'refreshThreads').mockResolvedValue()
  try {
    useCodex.getState().setContext('local', '/restored')
    for (const cb of listeners.get('target.state') ?? []) cb({ id: 'remote', state: 'ready' })
    expect(refresh).not.toHaveBeenCalled()
    for (const cb of listeners.get('target.state') ?? []) cb({ id: 'local', state: 'ready' })
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally {
    refresh.mockRestore()
    stop()
  }
})

it('同一目标的多个目录和不同目标的同名目录各自加载，迟到回包不会覆盖较新的列表', async () => {
  const replies: { targetId: string; cwd?: string; respond: (threadId: string) => void }[] = []
  callMock.mockImplementation((method: string, params?: CallParams) => {
    const msg = params?.msg
    if (method === 'codex.send' && msg?.method === 'thread/list') {
      const targetId = params?.targetId ?? 'local'
      const agent = params?.agent ?? 'codex'
      const cwd = msg.params?.cwd
      const respond = (threadId: string) => emitRecv({
        id: msg.id, result: { data: threadId ? [{ id: threadId, cwd }] : [] },
      }, agent, targetId)
      if (agent === 'codex') replies.push({ targetId, cwd, respond })
      else queueMicrotask(() => respond(''))
      return Promise.resolve({})
    }
    return fakeCall(method, params)
  })

  const store = useCodex.getState
  store().setContext('local', '/a')
  const oldA = store().refreshThreads()
  await vi.waitFor(() => expect(replies).toHaveLength(1))

  store().setContext('local', '/b')
  const b = store().refreshThreads()
  const remoteB = store().refreshThreads({ targetId: 'remote', cwd: '/b' })
  const newA = store().refreshThreads({ targetId: 'local', cwd: '/a' })
  await vi.waitFor(() => expect(replies).toHaveLength(4))

  replies.findLast((reply) => reply.cwd === '/a')?.respond('new-a')
  replies.find((reply) => reply.targetId === 'remote')?.respond('remote-b')
  replies.find((reply) => reply.targetId === 'local' && reply.cwd === '/b')?.respond('local-b')
  await Promise.all([b, remoteB, newA])
  replies[0]?.respond('old-a')
  await oldA

  expect(threadListFor(store(), 'local', '/a')?.threads.map(({ id }) => id)).toEqual(['new-a'])
  expect(threadListFor(store(), 'remote', '/b')?.threads.map(({ id }) => id)).toEqual(['remote-b'])
  expect(currentThreads(store()).map(({ id }) => id)).toEqual(['local-b'])
})

describe('审批会话隔离', () => {
  const approval = (id: string, threadId: string) => ({
    id, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'echo test' },
  })

  it('草稿、缺少缓存的会话和切换过程不显示其他会话的审批', async () => {
    const store = useCodex.getState
    await store().ensureOpen('local', 'codex')
    emitRecv(approval('a-request', 'a'))

    expect(currentThreadApprovals(store())).toEqual([])
    useCodex.setState({ currentThreadId: 'unloaded' })
    expect(currentThreadApprovals(store())).toEqual([])
    useCodex.setState({ currentThreadId: 'a' })
    expect(currentThreadApprovals(store())).toMatchObject([{ requestId: 'a-request', threadId: 'a' }])

    const before = callMock.mock.calls.length
    const address = { targetId: 'local', agent: 'codex', threadId: 'a' } as const
    useCodex.setState({ openingThread: { ...address, threadId: 'b' } })
    expect(currentThreadApprovals(store())).toEqual([])
    store().respondApproval(address, 'a-request', 'decline')
    useCodex.setState({ currentThreadId: 'b', openingThread: null })
    store().respondApproval(address, 'a-request', 'decline')
    expect(callMock.mock.calls).toHaveLength(before)
    expect(store().error).toBeNull()

    useCodex.setState({ currentThreadId: 'a' })
    expect(currentThreadApprovals(store())).toMatchObject([{ requestId: 'a-request' }])
    store().respondApproval(address, 'a-request', 'decline')
    expect(callMock).toHaveBeenLastCalledWith('codex.send', {
      targetId: 'local', agent: 'codex', msg: { id: 'a-request', result: { decision: 'decline' } },
    })
    expect(currentThreadApprovals(store())).toEqual([])
  })

  it('相同会话和审批 ID 在不同目标或 Agent 间独立', async () => {
    const store = useCodex.getState
    for (const [target, agent] of [['local', 'codex'], ['remote', 'codex'], ['local', 'claude']] as const) {
      await store().ensureOpen(target, agent)
      emitRecv(approval('same-request', 'same-thread'), agent, target)
    }
    useCodex.setState({ currentThreadId: 'same-thread', currentTargetId: 'remote' })
    const local = { targetId: 'local', agent: 'codex', threadId: 'same-thread' } as const
    const remote = { ...local, targetId: 'remote' }
    const before = callMock.mock.calls.length
    store().respondApproval(local, 'same-request', 'decline')
    expect(callMock.mock.calls).toHaveLength(before)
    store().respondApproval(remote, 'same-request', 'decline')
    expect(callMock).toHaveBeenLastCalledWith('codex.send', {
      targetId: 'remote', agent: 'codex', msg: { id: 'same-request', result: { decision: 'decline' } },
    })
    expect(currentThreadApprovals(store())).toEqual([])
    useCodex.setState({ currentTargetId: 'local' })
    expect(currentThreadApprovals(store())).toMatchObject([{ requestId: 'same-request' }])
    useCodex.setState({ currentAgent: 'claude' })
    expect(currentThreadApprovals(store())).toMatchObject([{ requestId: 'same-request' }])
  })

  it('侧聊只显示自己的审批，收起后保留待处理请求', async () => {
    const store = useCodex.getState
    useCodex.setState({ currentThreadId: 'parent' })
    await store().ensureOpen('local', 'codex')
    store().openSideChat()
    const key = currentChatKey(store())
    useCodex.setState({ sideChats: { [key]: { ...store().sideChats[key]!, threadId: 'side' } } })
    emitRecv(approval('main-request', 'parent'))
    emitRecv(approval('side-request', 'side'))

    expect(currentThreadApprovals(store())).toMatchObject([{ requestId: 'main-request' }])
    expect(currentSideApprovals(store())).toMatchObject([{ requestId: 'side-request' }])
    const side = { targetId: 'local', agent: 'codex', threadId: 'side' } as const
    store().closeSideChat()
    const before = callMock.mock.calls.length
    store().respondApproval(side, 'side-request', 'decline')
    expect(callMock.mock.calls).toHaveLength(before)
    expect(currentSideApprovals(store())).toEqual([])

    store().openSideChat()
    expect(currentSideApprovals(store())).toMatchObject([{ requestId: 'side-request' }])
    store().respondApproval(side, 'side-request', 'decline')
    expect(callMock).toHaveBeenLastCalledWith('codex.send', {
      targetId: 'local', agent: 'codex', msg: { id: 'side-request', result: { decision: 'decline' } },
    })
    expect(currentSideApprovals(store())).toEqual([])
    expect(currentThreadApprovals(store())).toMatchObject([{ requestId: 'main-request' }])
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

describe('输入框 Agent 错误', () => {
  const store = useCodex.getState

  it('远端缺少 Codex 时，切到 Claude 会清除 Codex 的发送错误并保留草稿', async () => {
    let finishClaude!: () => void
    const claude = new Promise((resolve) => {
      finishClaude = () => resolve({ initialize: {}, lastSeq: 0 })
    })
    callMock.mockImplementation(async (method: string, params?: CallParams) => {
      if (method === 'server.req' && params?.method === 'codex.open') {
        if (params.params?.agent === 'claude') return claude
        throw new Error(`${params.params?.agent} not found`)
      }
      return fakeCall(method, params)
    })
    store().setContext('remote', '/project')
    const draftKey = composerDraftKey(store())
    const probing = store().probeAgents('remote')
    const sending = store().send('你好')

    await expect(sending).resolves.toBe(false)
    expect(store().error).toContain('远端未找到 codex')
    finishClaude()
    await probing

    expect(store().currentAgent).toBe('claude')
    expect(store().error).toBeNull()
    expect(composerDraftKey(store())).toBe(draftKey)
    await expect(store().send('你好')).resolves.toBe(true)
    expect(callMock.mock.calls.filter(([, params]) => params?.msg?.method === 'turn/start')
      .map(([, params]) => [params.targetId, params.agent])).toEqual([['remote', 'claude']])
    await store().refreshThreads()
  })

  it('切到另一个目标的 Claude 草稿后忽略旧 Codex 发送的迟到错误', async () => {
    let failCodex!: () => void
    const opening = new Promise<never>((_, reject) => {
      failCodex = () => reject(new Error('codex not found'))
    })
    callMock.mockImplementation((method: string, params?: CallParams) =>
      method === 'server.req' && params?.method === 'codex.open' ? opening : fakeCall(method, params))
    useCodex.setState({ agents: {
      local: { codex: { state: 'unavailable' }, claude: { state: 'ready' }, pi: { state: 'unavailable' } },
    } })
    store().setContext('remote', '/old')
    const sending = store().send('你好')
    store().setContext('local', '/new')
    expect(store().currentAgent).toBe('claude')
    failCodex()

    await expect(sending).resolves.toBe(false)
    expect(store().sessions[sessionKey('remote', 'codex')]?.openError).toContain('远端未找到 codex')
    expect(store().error).toBeNull()
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
    const session = store().sessions[key]
    expect(session).toBeDefined()
    const rpc = session!.rpc
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
    expect(store().sideChats[owner]).toMatchObject({ draft: '', annotations: [{ quote: '一段引用' }] })
    await store().sendSide('', 'queue')
    expect(store().currentThreadId).toBe('parent')
    expect(store().sideChats[owner]).toMatchObject({ threadId: 't1', draft: '', annotations: [] })
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

it('旧 Pi 服务缺少无工具能力时保留草稿和引用并显示升级提示', async () => {
  useCodex.setState({ currentThreadId: 'parent', currentAgent: 'pi' })
  const store = useCodex.getState
  store().openSideChat('片段')
  store().setSideDraft('追问')
  await store().sendSide('追问', 'queue')
  expect(Object.values(store().sideChats)[0]).toMatchObject({
    draft: '追问', annotations: [{ quote: '片段' }], threadId: null, error: expect.stringContaining('升级'),
  })
  expect(callMock.mock.calls.some(([, params]) => params?.msg?.method === 'thread/start')).toBe(false)
})

it('服务端关闭临时会话后保留摘录，重新开始时继续使用同一主会话', async () => {
  const store = useCodex.getState
  useCodex.setState({ currentThreadId: 'parent' })
  store().openSideChat('一段摘录')
  await store().sendSide('', 'queue')
  emitRecv({ method: 'thread/closed', params: { threadId: 't1' } })
  expect(Object.values(store().sideChats)[0]?.expired).toBe(true)
  await store().restartSideChat()
  expect(Object.values(store().sideChats)[0]).toMatchObject({ threadId: null, expired: false, draft: '> 一段摘录' })
  expect(store().currentThreadId).toBe('parent')
})

it('侧聊发送时拼入编辑后的引用，保留提交期间新加的引用', async () => {
  useCodex.setState({ currentThreadId: 'parent' })
  const store = useCodex.getState
  const side = () => store().sideChats[currentChatKey(store())]!
  let turnRequestId: number | undefined
  callMock.mockImplementation((method: string, params?: CallParams) => {
    if (method === 'codex.send' && params?.msg?.method === 'turn/start') {
      turnRequestId = params.msg.id
      return Promise.resolve({})
    }
    return fakeCall(method, params)
  })
  store().openSideChat('原引用')
  store().addSideAnnotation('移除这条', '')
  const [original, removed] = side().annotations
  store().editSideAnnotation(original!.id, '修改后\n第二行')
  store().removeSideAnnotation(removed!.id)
  store().setSideDraft('追问')

  const sending = store().sendSide('追问', 'queue')
  await vi.waitFor(() => expect(turnRequestId).toBeDefined())
  const request = callMock.mock.calls.find(([, params]) => params?.msg?.id === turnRequestId && params.msg.method === 'turn/start')
  expect(request?.[1].msg.params.input).toEqual([
    expect.objectContaining({ type: 'text', text: '> 修改后\n> 第二行\n\n追问' }),
  ])
  store().openSideChat('下次发送的引用')
  emitRecv({ id: turnRequestId, result: { turn: { id: 'turn1', status: 'inProgress', items: [] } } })
  await sending
  expect(side()).toMatchObject({ draft: '', annotations: [{ quote: '下次发送的引用' }] })
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

it('从全部会话打开侧聊时沿用主会话的工作目录', async () => {
  callMock.mockImplementation((method: string, params?: CallParams) => {
    const msg = params?.msg
    if (method === 'codex.send' && msg?.method === 'thread/list' && params?.agent === 'codex') {
      queueMicrotask(() => emitRecv({ id: msg.id, result: { data: [{ id: 'parent', cwd: '/work/project' }] } }))
      return Promise.resolve({})
    }
    return fakeCall(method, params)
  })
  useCodex.setState({
    currentThreadId: 'parent', currentCwd: null,
  })
  await useCodex.getState().refreshThreads()
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
