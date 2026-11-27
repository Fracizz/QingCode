/**
 * bridge 层端到端：注入假的 query 工厂，跑 open → thread/start → turn/start → delta
 * → approval → turn/completed → interrupt，同时验证 seq/回放与 agent host 的中继规则。
 */
import type { Options, PermissionMode, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerMessage } from '@qn/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentHostError, type AgentHostHub } from '../codexHost'
import { AsyncQueue, ClaudeBridge, type ClaudeBridgeOptions, type ClaudeDeps, type QueryLike } from './bridge'
import type { Json } from './v2'

class FakeQuery implements QueryLike {
  readonly messages = new AsyncQueue<unknown>()
  readonly permissionChanges: PermissionMode[] = []
  interrupted = 0
  closed = false
  constructor(
    readonly prompt: unknown,
    readonly options: Options | undefined,
  ) {}

  emit(msg: unknown): void {
    this.messages.push(msg)
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.messages[Symbol.asyncIterator]()
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionChanges.push(mode)
  }

  async supportedCommands(): Promise<unknown[]> {
    return [{ name: path.basename(this.options?.env?.CLAUDE_CONFIG_DIR ?? 'default'), description: '自定义技能' },
      { name: 'help', builtin: true }]
  }

  close(): void {
    this.closed = true
    this.messages.close()
  }
}

interface Harness {
  bridge: ClaudeBridge
  sent: { clientId: number; msg: ServerMessage }[]
  recv: { seq: number; msg: Json }[]
  events: { name: string; payload: Json }[]
  queries: FakeQuery[]
}

function harness(options: {
  failResolve?: boolean
  listSessions?: ClaudeDeps['listSessions']
  getSessionMessages?: ClaudeDeps['getSessionMessages']
  forkSession?: ClaudeDeps['forkSession']
  sessionReader?: ClaudeBridgeOptions['sessionReader']
  stateDir?: string
} = {}): Harness {
  const sent: Harness['sent'] = []
  const recv: Harness['recv'] = []
  const events: Harness['events'] = []
  const queries: FakeQuery[] = []
  const hub: AgentHostHub = {
    send: (clientId, msg) => sent.push({ clientId, msg }),
    broadcastRecv: (seq, msg) => recv.push({ seq, msg }),
    broadcastEvt: (name, payload) => events.push({ name, payload }),
    log: () => {},
  }
  const oldSession = { sessionId: 'old-1', summary: '历史会话', cwd: '/work', lastModified: 1_700_000_000_000 }
  const deps: ClaudeDeps = {
    query: (params) => {
      const query = new FakeQuery(params.prompt, params.options)
      queries.push(query)
      return query
    },
    listSessions: options.listSessions ?? (async () => [oldSession]),
    getSessionInfo: async (id) => id === oldSession.sessionId ? oldSession : undefined,
    forkSession: options.forkSession,
    getSessionMessages: options.getSessionMessages ?? (async () => [
      {
        message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '历史问题' }] },
      },
      {
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '历史回答' }] },
      },
    ]),
  }
  const bridge = new ClaudeBridge(hub, '0.0.1', {
    deps,
    sessionReader: options.sessionReader,
    stateDir: options.stateDir,
    resolve: (claudePath) => {
      if (options.failResolve) {
        throw new AgentHostError('agent_unavailable', `未找到 claude (${claudePath ?? ''})`)
      }
      return { path: 'C:/fake/claude.exe', version: '2.1.331' }
    },
    idleTimeoutMs: 60_000,
  })
  return { bridge, sent, recv, events, queries }
}

function request(h: Harness, id: string, method: string, params?: Json): void {
  h.bridge.handleClientMessage(1, { id, method, ...(params ? { params } : {}) })
}

async function response(h: Harness, id: string, timeoutMs = 3000): Promise<Json> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = h.sent.find((entry) => {
      const frame = entry.msg as Json
      const inner = frame.msg as Json | undefined
      return frame.t === 'codex.recv' && inner?.id === id
    })
    if (found) return ((found.msg as Json).msg ?? {}) as Json
    await sleep(10)
  }
  throw new Error(`等待响应 ${id} 超时；sent=${JSON.stringify(h.sent)}`)
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(10)
  }
  throw new Error('等待条件超时')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasNote(h: Harness, method: string): boolean {
  return h.recv.some((entry) => entry.msg.method === method)
}

function note(h: Harness, method: string): Json {
  const found = h.recv.find((entry) => entry.msg.method === method)
  if (!found) throw new Error(`没有 ${method} 通知`)
  return found.msg
}

describe('ClaudeBridge 端到端（假 query 工厂）', () => {
  it('以 SDK 回显确认引导归属，并在 Claude 已排好下一轮时保持会话运行', async () => {
    const transcript: { uuid: string; message: unknown }[] = []
    const stateDir = mkdtempSync(path.join(tmpdir(), 'qn-claude-steering-'))
    const options = { stateDir, getSessionMessages: async () => transcript }
    const h = harness(options)
    const restarted = harness(options)
    const threadId = 'old-1'
    const first = '00000000-0000-4000-8000-000000000001'
    const same = '00000000-0000-4000-8000-000000000002'
    const next = '00000000-0000-4000-8000-000000000003'
    const input = (text: string) => [{ type: 'text', text, text_elements: [] }]
    const notifications = (method: string) => h.recv.filter(({ msg }) => msg.method === method).map(({ msg }) => msg.params as Json)
    try {
      await h.bridge.open({})
      request(h, 'start-steer-test', 'turn/start', { threadId, input: input('开始'), clientUserMessageId: first })
      const turnId = ((await response(h, 'start-steer-test')).result as { turn: { id: string } }).turn.id
      const query = h.queries[0]!
      const prompt = (query.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
      transcript.push({ uuid: first, message: (await prompt.next()).value.message })

      request(h, 'stale-steer', 'turn/steer', { threadId, expectedTurnId: 'old-turn', input: input('已过期') })
      expect((await response(h, 'stale-steer')).error).toMatchObject({ code: -32602 })

      for (const [id, text] of [[same, '补充到当前轮'], [next, '补充到下一轮']] as const) {
        request(h, id, 'turn/steer', { threadId, expectedTurnId: turnId, input: input(text), clientUserMessageId: id })
        expect((await response(h, id)).result).toEqual({ turnId })
        const { value } = await prompt.next()
        expect(value).toMatchObject({ priority: 'next', origin: { kind: 'human' }, uuid: id })
        transcript.push({ uuid: id, message: value.message })
      }
      expect(notifications('item/completed')).toEqual([])

      query.emit({ type: 'result', subtype: 'success', user_message_uuids: [first, same], queued_turn_count: 1 })
      await until(() => notifications('turn/started').length === 2)
      const nextTurn = (notifications('turn/started')[1]!.turn as Json).id
      expect(nextTurn).not.toBe(turnId)
      expect(h.bridge.activeTurns).toBe(1)
      expect(notifications('item/completed')).toMatchObject([
        { turnId, item: { id: same, steering: 'currentTurn' } },
      ])

      query.emit({ type: 'result', subtype: 'success', user_message_uuid: next, queued_turn_count: 0 })
      await until(() => notifications('turn/completed').length === 2)
      expect(notifications('item/completed')).toMatchObject([
        { turnId, item: { id: same, steering: 'currentTurn' } },
        { turnId: nextTurn, item: { id: next, steering: 'nextTurn' } },
      ])
      expect(h.bridge.activeTurns).toBe(0)

      await restarted.bridge.open({})
      request(restarted, 'steer-history', 'thread/read', { threadId })
      expect((await response(restarted, 'steer-history')).result).toMatchObject({ thread: { turns: [
        { items: [{ id: first }, { id: same, steering: 'currentTurn' }] },
        { items: [{ id: next, steering: 'nextTurn' }] },
      ] } })
    } finally {
      h.bridge.shutdown()
      restarted.bridge.shutdown()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('按历史轮次或实时轮次找到 Claude 消息边界，并打开独立的会话', async () => {
    const threadId = 'old-1'
    const message = (uuid: string, role: string, text: string) => ({
      uuid, message: { role, content: [{ type: 'text', text }] },
    })
    const firstTurn = [message('first', 'user', '前一轮'), message('first-reply', 'assistant', '前一轮回答')]
    const transcript = [...firstTurn]
    const forkSession = vi.fn(async () => ({ sessionId: 'branch' }))
    const h = harness({
      forkSession,
      getSessionMessages: async (id) => id === threadId ? transcript : firstTurn,
    })
    try {
      await h.bridge.open({})
      request(h, 'send', 'turn/start', { threadId, input: [{ type: 'text', text: '下一轮' }] })
      const started = await response(h, 'send')
      const { id: liveTurnId } = (started.result as { turn: { id: string } }).turn
      const query = h.queries[0]!
      const prompt = await (query.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()
      const uuid = prompt.value.uuid as string
      transcript.push(message(uuid, 'user', '下一轮'), message('live-reply', 'assistant', '这一轮回答'))
      request(h, 'past-fork', 'thread/fork', { threadId, lastTurnId: 'turn-old-1-0' })
      expect(await response(h, 'past-fork')).toMatchObject({
        result: { thread: { id: 'branch', turns: [{ items: [expect.anything(), { text: '前一轮回答' }] }] } },
      })
      expect(forkSession).toHaveBeenLastCalledWith(threadId, { dir: '/work', upToMessageId: 'first-reply' })
      request(h, 'running-fork', 'thread/fork', { threadId, lastTurnId: liveTurnId })
      expect(await response(h, 'running-fork')).toMatchObject({ error: { code: -32602 } })
      query.emit({ type: 'result', subtype: 'success' })
      await until(() => hasNote(h, 'turn/completed'))
      request(h, 'live-fork', 'thread/fork', { threadId, lastTurnId: liveTurnId })
      expect(await response(h, 'live-fork')).toHaveProperty('result')
      expect(forkSession).toHaveBeenLastCalledWith(threadId, { dir: '/work', upToMessageId: 'live-reply' })
      expect(h.queries).toHaveLength(1)
    } finally {
      h.bridge.shutdown()
    }
  })

  it('空闲时转发后台任务结果，历史回放复用同一通知且不多切一轮', async () => {
    const userMessage = { type: 'user', uuid: 'prompt', message: { role: 'user', content: '开始检查' } }
    const transcript: Json[] = [userMessage]
    const h = harness({ getSessionMessages: async () => transcript })
    const threadId = 'old-1'
    try {
      await h.bridge.open({})
      request(h, 'send', 'turn/start', { threadId, input: [{ type: 'text', text: '开始检查' }] })
      await response(h, 'send')
      const query = h.queries[0]!
      query.emit({ type: 'result', subtype: 'success' })
      await until(() => hasNote(h, 'turn/completed'))

      for (const index of [0, 1]) {
        query.emit({
          type: 'system', subtype: 'task_notification', uuid: `event-${index}`, task_id: 'task1',
          status: 'completed', summary: '后台检查',
        })
      }
      for (const index of [0, 1]) {
        const summary = '后台检查'
        const result = `**结果 ${index + 1}**`
        const content = [
          '<task-notification>', '<task-id>task1</task-id>', '<tool-use-id>tool1</tool-use-id>',
          '<output-file>C:\\Temp\\task1.output</output-file>', '<status>completed</status>',
          `<summary>${summary}</summary>`, '<note>可继续运行</note>', `<result>${result}</result>`, '</task-notification>',
        ].join('\n')
        const delivery = { type: 'user', uuid: `delivery-${index}`, message: { role: 'user', content: [{ type: 'text', text: content }] } }
        query.emit(delivery)
        transcript.push(delivery)
      }
      await until(() => h.recv.filter(({ msg }) => msg.method === 'item/completed').length === 4)
      const updates = h.recv.filter(({ msg }) => msg.method === 'item/completed')
        .map(({ msg }) => (msg.params as Json).item as Json)
      expect(updates[0]?.id).toBe(updates[2]?.id)
      expect(updates[1]?.id).toBe(updates[3]?.id)
      expect(updates[2]?.id).not.toBe(updates[3]?.id)
      expect(updates[2]).toMatchObject({ type: 'backgroundTaskNotification', status: 'completed', result: '**结果 1**' })
      expect(updates[3]).toMatchObject({ type: 'backgroundTaskNotification', status: 'completed', result: '**结果 2**' })
      expect(h.recv.filter(({ msg }) => msg.method === 'turn/started')).toHaveLength(1)

      request(h, 'read', 'thread/read', { threadId })
      expect((await response(h, 'read')).result).toMatchObject({
        thread: { status: { type: 'idle' }, turns: [{ items: [
          { type: 'userMessage', id: 'prompt' }, updates[2], updates[3],
        ] }] },
      })
    } finally {
      h.bridge.shutdown()
    }
  })

  it('SDK 输入、实时回显和历史复用同一条带图消息的 UUID', async () => {
    const transcript: { uuid?: string; message: unknown }[] = []
    const h = harness({ getSessionMessages: async () => transcript })
    const threadId = 'old-1'
    const clientUserMessageId = '00000000-0000-4000-8000-000000000001'
    const input = [
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'text', text: '看图', text_elements: [] },
    ]
    try {
      await h.bridge.open({})
      request(h, 'send', 'turn/start', { threadId, input, clientUserMessageId })
      const echo = { type: 'userMessage', id: clientUserMessageId, clientId: clientUserMessageId }
      expect((await response(h, 'send')).result).toMatchObject({ turn: { items: [echo] } })
      expect(note(h, 'turn/started').params).toMatchObject({ turn: { items: [echo] } })
      const prompt = h.queries[0]!.prompt as AsyncIterable<SDKUserMessage>
      const { value } = await prompt[Symbol.asyncIterator]().next()
      expect(value.uuid).toBe(clientUserMessageId)
      transcript.push({ uuid: value.uuid, message: value.message })
      request(h, 'read', 'thread/read', { threadId })
      expect((await response(h, 'read')).result).toMatchObject({
        thread: { turns: [
          { items: [{ type: 'userMessage', id: clientUserMessageId, content: input }] },
          { status: 'inProgress', items: [] },
        ] },
      })
    } finally {
      h.bridge.shutdown()
    }
  })

  it('压缩走 SDK 原生命令，收到压缩边界才报告成功', async () => {
    const supported = vi.spyOn(FakeQuery.prototype, 'supportedCommands').mockResolvedValue([{ name: 'compact' }])
    const h = harness()
    try {
      await h.bridge.open({})
      const threadId = 'old-1'
      request(h, 'compact', 'thread/compact/start', { threadId })
      expect((await response(h, 'compact')).result).toEqual({})
      const query = h.queries[0]!
      expect(query.options?.resume).toBe(threadId)
      const input = (query.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      expect((await input.next()).value).toMatchObject({ message: { content: [{ type: 'text', text: '/compact' }] } })
      expect(note(h, 'turn/started').params).toMatchObject({ threadId, turn: { items: [] } })
      request(h, 'repeat', 'thread/compact/start', { threadId })
      expect((await response(h, 'repeat')).error).toMatchObject({ code: -32602 })
      query.emit({ type: 'system', subtype: 'status', status: 'compacting' })
      query.emit({ type: 'system', subtype: 'compact_boundary' })
      query.emit({ type: 'result', subtype: 'success', result: 'Compacted' })
      await until(() => hasNote(h, 'turn/completed'))
      expect(note(h, 'turn/completed').params).toMatchObject({
        threadId, turn: { status: 'completed', items: [{ type: 'contextCompaction', status: 'completed' }] },
      })

      h.recv.length = 0
      request(h, 'too-short', 'thread/compact/start', { threadId })
      expect((await response(h, 'too-short')).result).toEqual({})
      query.emit({ type: 'result', subtype: 'success', result: 'Not enough messages' })
      await until(() => hasNote(h, 'turn/completed'))
      expect(note(h, 'turn/completed').params).toMatchObject({ turn: { status: 'failed' } })
    } finally {
      h.bridge.shutdown()
      supported.mockRestore()
    }
  })

  it('元数据预读一次历史以回报会话模型，分页从最近轮次回读并复用同一份 SDK 快照', async () => {
    const readMessages = vi.fn(async () => [0, 1, 2].flatMap((index) => [
      { message: { id: `u${index}`, role: 'user', content: [{ type: 'text', text: `问题 ${index}` }] } },
      { message: { id: `a${index}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `回答 ${index}` }] } },
    ]))
    const h = harness({ getSessionMessages: readMessages })
    await h.bridge.open({})
    const threadId = 'old-1'
    request(h, 'metadata', 'thread/resume', { threadId, excludeTurns: true })
    expect((await response(h, 'metadata')).result).toMatchObject({
      thread: { id: threadId, historyMode: 'paginated', turns: [], model: 'claude-opus-5-5', reasoningEffort: null },
    })
    request(h, 'read-metadata', 'thread/read', { threadId, includeTurns: false })
    expect((await response(h, 'read-metadata')).result).toMatchObject({ thread: { turns: [], model: 'claude-opus-5-5' } })
    expect(readMessages).toHaveBeenCalledTimes(1)

    const params = { threadId, sortDirection: 'desc', limit: 1, itemsView: 'full' }
    request(h, 'latest', 'thread/turns/list', params)
    const latest = (await response(h, 'latest')).result as Json
    expect(latest).toMatchObject({
      data: [{ id: 'turn-old-1-4', items: [{ type: 'userMessage' }, { type: 'agentMessage', text: '回答 2' }] }],
      nextCursor: expect.any(String),
    })
    request(h, 'previous', 'thread/turns/list', { ...params, cursor: latest.nextCursor })
    expect((await response(h, 'previous')).result).toMatchObject({
      data: [{ id: 'turn-old-1-2' }],
      nextCursor: expect.any(String),
    })
    request(h, 'items', 'thread/items/list', { threadId, turnId: 'turn-old-1-4', sortDirection: 'desc', limit: 1 })
    expect((await response(h, 'items')).result).toMatchObject({
      data: [{ turnId: 'turn-old-1-4', item: { type: 'agentMessage', text: '回答 2' } }],
      nextCursor: expect.any(String),
    })
    expect(readMessages).toHaveBeenCalledTimes(1)
    expect(h.queries).toHaveLength(0)
    h.bridge.shutdown()
  })

  it('跨项目查询按更新时间合并，并保留原项目目录', async () => {
    const h = harness({ listSessions: async (options) => {
      expect(options).toMatchObject({ limit: 2, includeWorktrees: false })
      return options?.dir === '/first' ? [
        { sessionId: 'a', lastModified: 1_000 },
        { sessionId: 'b', lastModified: 3_000 },
      ] : [
        { sessionId: 'c', lastModified: 2_000 },
      ]
    } })
    await h.bridge.open({})
    request(h, 'list', 'thread/list', { cwd: ['/first', '/second'], limit: 2 })
    expect((await response(h, 'list')).result).toMatchObject({
      data: [{ id: 'b', cwd: '/first' }, { id: 'c', cwd: '/second' }],
      nextCursor: null,
    })
    expect(h.queries).toHaveLength(0)
  })

  it('直接打开历史 ID 时找到原项目，找不到的 ID 返回错误', async () => {
    const h = harness()
    await h.bridge.open({})

    request(h, 'old', 'thread/resume', { threadId: 'old-1', cwd: '/another-project' })
    expect((await response(h, 'old')).result).toMatchObject({
      thread: { id: 'old-1', cwd: '/work', turns: [{ status: 'completed' }] },
    })
    request(h, 'missing', 'thread/read', { threadId: 'missing' })
    expect((await response(h, 'missing')).error).toMatchObject({ message: '未找到 Claude 会话' })
    expect(h.queries).toHaveLength(0)
  })

  it('open / thread / turn / delta / approval / completed / interrupt / attach', async () => {
    const sessionInfos = [{ sessionId: 'old-1', summary: '历史会话', cwd: '/work', lastModified: 1_700_000_000_000 }]
    const h = harness({ listSessions: async () => sessionInfos })
    const opened = await h.bridge.open({})
    expect(opened.initialize).toEqual({ userAgent: 'claude-bridge/2.1.331' })
    expect(opened.lastSeq).toBe(0)
    expect(opened.agentVersion).toBe('2.1.331')
    expect(h.bridge.status()).toEqual({ running: true, activeTurns: 0 })

    request(h, 'r-list', 'thread/list', { cwd: '/work' })
    const listed = await response(h, 'r-list')
    expect((listed.result as Json).data).toHaveLength(1)

    request(h, 'r-read', 'thread/read', { threadId: 'old-1' })
    const read = await response(h, 'r-read')
    expect(((read.result as Json).thread as Json).id).toBe('old-1')
    expect((((read.result as Json).thread as Json).turns as Json[])).toHaveLength(1)

    request(h, 'r-start', 'thread/start', { cwd: '/work' })
    const startedThread = await response(h, 'r-start')
    const threadId = ((startedThread.result as Json).thread as Json).id as string
    expect(threadId).toBeTypeOf('string')
    sessionInfos.push({ sessionId: threadId, summary: '新会话', cwd: '/work', lastModified: Date.now() })

    request(h, 'r-turn', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: '只回复两个字：你好', text_elements: [] }],
    })
    const turnResult = await response(h, 'r-turn')
    const turn = (turnResult.result as Json).turn as Json
    expect(turn.status).toBe('inProgress')
    expect(turn.id).toBeTypeOf('string')
    await until(() => hasNote(h, 'turn/started'))
    expect(h.bridge.status().activeTurns).toBe(1)

    const query = h.queries[0]
    expect(query).toBeDefined()
    expect(query?.options?.includePartialMessages).toBe(true)
    expect(query?.options?.permissionMode).toBe('default')
    expect(query?.options?.pathToClaudeCodeExecutable).toBe('C:/fake/claude.exe')
    expect(query?.options?.sessionId).toBe(threadId)
    expect(query?.options?.resume).toBeUndefined()
    // 用户消息进入异步输入队列，而不是每轮重新创建 query。
    const prompt = query?.prompt as AsyncQueue<SDKUserMessage>
    expect(prompt).toBeInstanceOf(AsyncQueue)

    query?.emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg-1' } },
    })
    query?.emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你好' },
      },
    })
    await until(() => hasNote(h, 'item/agentMessage/delta'))
    expect(note(h, 'item/agentMessage/delta').params).toMatchObject({ delta: '你好', threadId })

    query?.emit({
      type: 'assistant',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'text', text: '你好' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'echo qn-ok' } },
        ],
      },
    })
    await until(() => hasNote(h, 'turn/started') && h.recv.filter((e) => e.msg.method === 'item/started').length >= 2)

    // canUseTool → 广播审批请求；客户端首个响应生效并转成 SDK PermissionResult。
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'echo' }],
        behavior: 'allow',
        destination: 'userSettings',
      },
    ]
    let permission: PermissionResult | null = null
    const canUseTool = query?.options?.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      extra: Json,
    ) => Promise<PermissionResult>
    void canUseTool('Bash', { command: 'echo qn-ok' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-1',
      suggestions,
    }).then((result) => {
      permission = result
    })
    await until(() => h.recv.some((e) => e.msg.method === 'item/commandExecution/requestApproval'))
    const approval = h.recv.find((e) => e.msg.method === 'item/commandExecution/requestApproval')?.msg as Json
    expect(approval.params).toMatchObject({ command: 'echo qn-ok', threadId })
    request(h, 'list-active', 'thread/list', { cwd: '/work' })
    expect((await response(h, 'list-active')).result).toMatchObject({
      data: [{ id: threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } }, { id: 'old-1' }],
    })
    request(h, 'read-active', 'thread/read', { threadId })
    const activeResult = (await response(h, 'read-active')).result
    expect(activeResult).toMatchObject({
      thread: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
    })
    const activeThread = (activeResult as { thread: { turns: Json[] } }).thread
    expect(activeThread.turns.at(-1)).toMatchObject({ id: turn.id, status: 'inProgress' })
    const approvalId = approval.id as string
    h.bridge.handleClientMessage(1, { id: approvalId, result: { decision: 'acceptForSession' } })
    await until(() => permission !== null)
    expect(permission).toMatchObject({ behavior: 'allow' })
    expect((permission as unknown as Json).updatedPermissions).toEqual([
      { ...suggestions[0], destination: 'session' },
    ])
    await until(() => hasNote(h, 'serverRequest/resolved'))

    query?.emit({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'qn-ok', is_error: false }],
      },
    })
    query?.emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.9,
        resetsAt: 1_800_000_000,
      },
    })
    query?.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 2 },
      total_cost_usd: 0.01,
      result: '你好',
    })
    await until(() => hasNote(h, 'turn/completed'))
    expect(h.bridge.status().activeTurns).toBe(0)
    expect(hasNote(h, 'thread/tokenUsage/updated')).toBe(true)
    expect(hasNote(h, 'account/rateLimits/updated')).toBe(true)
    const completed = (note(h, 'turn/completed').params as Json).turn as Json
    expect(completed.status).toBe('completed')

    request(h, 'r-limits', 'account/rateLimits/read', {})
    const limits = await response(h, 'r-limits')
    expect(((limits.result as Json).rateLimits as Json).primary).toMatchObject({ usedPercent: 90 })

    const rejectionResetsAt = Math.floor(Date.now() / 1000) + 600
    query?.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: rejectionResetsAt } })
    await until(() => h.recv.some((entry) => {
      const snapshot = (entry.msg.params as Json | undefined)?.rateLimits as Json | undefined
      return snapshot?.rateLimitReachedType === 'rate_limit_reached'
    }))
    const rejection = { primary: null, rejectionResetsAt, observedAt: expect.any(Number), rateLimitReachedType: 'rate_limit_reached' }
    request(h, 'r-rejection', 'account/rateLimits/read', {})
    expect(await response(h, 'r-rejection')).toMatchObject({ result: { rateLimits: rejection } })

    request(h, 'r-unknown', 'account/login/start', {})
    const unsupported = await response(h, 'r-unknown')
    expect((unsupported.error as Json).code).toBe(-32601)

    // 第二轮：同一 query 的输入队列复用，中断后 SDK 的 error_during_execution → interrupted。
    request(h, 'r-turn2', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: '用 Bash 运行 echo qn-ok' }],
    })
    await response(h, 'r-turn2')
    expect(h.queries).toHaveLength(1)
    request(h, 'r-interrupt', 'turn/interrupt', { threadId, turnId: 'whatever' })
    expect(await response(h, 'r-interrupt')).toMatchObject({ result: {} })
    expect(query?.interrupted).toBe(1)
    query?.emit({ type: 'result', subtype: 'error_during_execution', errors: [], usage: {} })
    await until(() => h.recv.filter((e) => e.msg.method === 'turn/completed').length === 2)
    const interrupted = h.recv
      .filter((e) => e.msg.method === 'turn/completed')
      .at(-1)?.msg.params as Json
    expect((interrupted.turn as Json).status).toBe('interrupted')

    // seq 递增、attach 回放所有 seq > 0 的广播，且按序在 res 之前下发。
    const seqs = h.recv.map((entry) => entry.seq)
    expect(seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] as number))).toBe(true)
    const before = h.sent.length
    const attached = h.bridge.attach(1, 0)
    expect(attached.lastSeq).toBe(h.recv.length)
    expect(attached.truncated).toBe(false)
    const replayed = h.sent.slice(before)
    expect(replayed).toHaveLength(h.recv.length)
    expect(replayed[0]?.msg.t).toBe('codex.recv')
    expect((replayed[0]?.msg as Json).seq).toBe(1)

    h.bridge.shutdown()
    expect(query?.closed).toBe(true)
    expect(h.bridge.status().running).toBe(false)
  }, 20_000)

  it('claude 可执行文件找不到时返回 agent_unavailable，且未 open 时发请求会报错', async () => {
    const h = harness({ failResolve: true })
    let error: unknown
    try {
      await h.bridge.open({ claudePath: 'C:/missing.exe' })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(AgentHostError)
    expect((error as AgentHostError).code).toBe('agent_unavailable')

    request(h, 'r-early', 'thread/list', {})
    const early = await response(h, 'r-early')
    expect((early.error as Json).code).toBe(-32000)
  })

  it('turn/start 支持图片输入：SDK 收到图片块在前、文本在后，回显含 image 项', async () => {
    const h = harness()
    await h.bridge.open({})
    request(h, 'r-start', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 'r-start')).result as Json).thread as Json).id as string
    request(h, 'r-turn', 'turn/start', {
      threadId,
      input: [
        { type: 'text', text: '看这张图', text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,QUJD' },
        { type: 'skill', name: 'review', path: '/x/SKILL.md' },
        { type: 'mention', name: 'a.txt', path: '/w/a.txt' },
      ],
    })
    const turn = ((await response(h, 'r-turn')).result as Json).turn as Json
    expect(((turn.items as Json[])[0]?.content as Json[])[0]).toEqual({
      type: 'image',
      url: 'data:image/png;base64,QUJD',
    })
    const prompt = h.queries[0]?.prompt as AsyncQueue<SDKUserMessage>
    const first = await prompt[Symbol.asyncIterator]().next()
    const content = (first.value as unknown as { message: { content: Json[] } }).message.content
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    })
    expect(content[1]?.type).toBe('text')
    expect(content[1]?.text).toBe('/review 看这张图\n\n附件文件（请按需读取）：\n- a.txt: /w/a.txt')
  })

  it('按轮应用用户选的权限，并使普通轮次恢复默认权限', async () => {
    const h = harness()
    await h.bridge.open()
    request(h, 'start', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 'start')).result as Json).thread as Json).id as string
    const input = [{ type: 'text', text: '检查文件' }]
    const send = async (id: string, mode?: string) => {
      request(h, id, 'turn/start', { threadId, input, claudePermissionMode: mode })
      expect(await response(h, id)).toHaveProperty('result.turn.status', 'inProgress')
    }
    const complete = async () => {
      h.queries.at(-1)?.emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
      await until(() => h.bridge.activeTurns === 0)
    }

    try {
      await send('plan', 'plan')
      expect(h.queries[0]?.options).toMatchObject({ permissionMode: 'plan' })
      expect(h.queries[0]?.options?.allowDangerouslySkipPermissions).toBeUndefined()
      await complete()

      await send('edit', 'acceptEdits')
      expect(h.queries).toHaveLength(1)
      expect(h.queries[0]?.permissionChanges).toEqual(['acceptEdits'])
      await complete()

      await send('auto', 'auto')
      expect(h.queries).toHaveLength(1)
      expect(h.queries[0]?.permissionChanges).toEqual(['acceptEdits', 'auto'])
      await complete()

      await send('bypass', 'bypassPermissions')
      expect(h.queries[0]?.closed).toBe(true)
      expect(h.queries[1]?.options).toMatchObject({
        resume: threadId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      })
      await complete()

      await send('default')
      expect(h.queries).toHaveLength(2)
      expect(h.queries[1]?.permissionChanges).toEqual(['default'])
      await complete()

      request(h, 'unknown', 'turn/start', { threadId, input, claudePermissionMode: 'unsupported' })
      expect((await response(h, 'unknown')).error).toMatchObject({ code: -32602 })
      expect(h.bridge.activeTurns).toBe(0)
    } finally {
      h.bridge.shutdown()
    }
  })

  it('配置目录的改变只应用到后来启动的 query', async () => {
    const h = harness()
    const original = path.resolve('claude-original')
    const changed = path.resolve('claude-changed')
    const openThread = async (id: string) => {
      request(h, id, 'thread/start', { cwd: '/work' })
      return (((await response(h, id)).result as Json).thread as Json).id as string
    }
    const send = async (id: string, threadId: string) => {
      request(h, id, 'turn/start', { threadId, input: [{ type: 'text', text: '你好' }] })
      expect(await response(h, id)).toHaveProperty('result.turn.status', 'inProgress')
    }

    try {
      await h.bridge.open({ claudeConfigDir: original })
      const first = await openThread('first')
      await send('first-turn', first)
      expect(h.queries[0]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(original)

      await expect(h.bridge.open({ claudeConfigDir: 'relative' })).rejects.toMatchObject({ code: 'params' })
      await h.bridge.open({ claudeConfigDir: changed })
      expect(h.queries[0]?.closed).toBe(false)
      expect(h.queries[0]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(original)
      await send('second-turn', await openThread('second'))
      expect(h.queries[1]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(changed)

      await h.bridge.open()
      await send('third-turn', await openThread('third'))
      expect(h.queries[2]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)
    } finally {
      h.bridge.shutdown()
    }
  })

  it('配置目录隔离会话元数据、历史分页和已打开会话的命令', async () => {
    const first = path.resolve('profile-a')
    const second = path.resolve('profile-b')
    const sessionId = 'shared-session'
    const cwd = '/work'
    const sessionReader = vi.fn((directory: string) => {
      const name = path.basename(directory)
      const info = { sessionId, summary: name, cwd, lastModified: 1_700_000_000_000 }
      return {
        listSessions: async () => [info],
        getSessionInfo: async (id: string) => id === sessionId ? info : undefined,
        getSessionMessages: async () => [{
          uuid: 'history', message: { role: 'user', content: [{ type: 'text', text: name }] },
        }],
      }
    })
    const h = harness({ sessionReader })
    const rpc = async (id: string, method: string, params: Json) => {
      request(h, id, method, params)
      return response(h, id)
    }
    const skills = (id: string) => rpc(id, 'skills/list', { cwds: [cwd] })
    const turns = (id: string) => rpc(id, 'thread/turns/list', { threadId: sessionId })
    try {
      await h.bridge.open({ claudeConfigDir: first })
      expect(await skills('skills-before')).toHaveProperty('result.data.0.skills', [])
      expect(h.queries).toHaveLength(0)
      expect(await rpc('list-a', 'thread/list', { cwd })).toHaveProperty('result.data.0.preview', 'profile-a')
      expect(JSON.stringify(await turns('history-a'))).toContain('profile-a')
      await rpc('send-a', 'turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'A' }] })
      expect(await skills('skills-a')).toHaveProperty('result.data.0.skills.0.name', 'profile-a')
      expect(await skills('skills-a-builtins')).toHaveProperty('result.data.0.skills.length', 1)

      await h.bridge.open({ claudeConfigDir: second })
      expect(await skills('skills-b-before')).toHaveProperty('result.data.0.skills', [])
      const history = JSON.stringify(await turns('history-b'))
      expect(history).toContain('profile-b')
      expect(history).not.toContain('profile-a')
      await rpc('send-b', 'turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'B' }] })
      expect(h.queries.map((entry) => entry.options?.env?.CLAUDE_CONFIG_DIR)).toEqual([first, second])
      expect(await skills('skills-b-after')).toHaveProperty('result.data.0.skills.0.name', 'profile-b')
      expect(sessionReader).toHaveBeenCalledWith(first)
      expect(sessionReader).toHaveBeenCalledWith(second)
    } finally {
      h.bridge.shutdown()
    }
  })

  it('turn/start 没有文本/图片/附件，或图片类型不支持时返回 -32602', async () => {
    const h = harness()
    await h.bridge.open({})
    request(h, 'r-start', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 'r-start')).result as Json).thread as Json).id as string
    request(h, 'r-empty', 'turn/start', { threadId, input: [] })
    expect(((await response(h, 'r-empty')).error as Json).code).toBe(-32602)
    request(h, 'r-bad', 'turn/start', {
      threadId,
      input: [{ type: 'image', url: 'data:image/bmp;base64,QUJD' }],
    })
    expect(((await response(h, 'r-bad')).error as Json).code).toBe(-32602)
  })

  it('skills/list 扫描传入 cwd 并返回 data 结构', async () => {
    const h = harness()
    await h.bridge.open({})
    request(h, 'r-skills', 'skills/list', { cwds: ['/definitely/not/here'] })
    const result = (await response(h, 'r-skills')).result as Json
    const data = result.data as Json[]
    expect(data).toHaveLength(1)
    expect(data[0]?.cwd).toBe('/definitely/not/here')
    expect(Array.isArray(data[0]?.skills)).toBe(true)
    expect(data[0]?.errors).toEqual([])
  })

  it('shutdown 会拒绝未决审批并清理会话', async () => {
    const h = harness()
    await h.bridge.open({})
    request(h, 'r-start', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 'r-start')).result as Json).thread as Json).id as string
    request(h, 'r-turn', 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'hi' }],
    })
    await response(h, 'r-turn')
    const query = h.queries[0]
    let denied: PermissionResult | null = null
    const canUseTool = query?.options?.canUseTool as (
      a: string,
      b: Record<string, unknown>,
      c: Json,
    ) => Promise<PermissionResult>
    void canUseTool('Read', {}, { signal: new AbortController().signal, toolUseID: 'tu' }).then(
      (result) => {
        denied = result
      },
    )
    await until(() => h.recv.some((e) => e.msg.method === 'item/commandExecution/requestApproval'))
    h.bridge.shutdown()
    await until(() => denied !== null)
    expect(denied).toEqual({ behavior: 'deny', message: 'server 正在退出' })
    expect(query?.closed).toBe(true)
  })
})

it('临时 Claude 查询在收起后可追问，显式结束才释放', async () => {
  const h = harness()
  await h.bridge.open({})
  request(h, 'new', 'thread/start', { cwd: '/work', ephemeral: true })
  const threadId = (((await response(h, 'new')).result as Json).thread as Json).id as string
  request(h, 'send', 'turn/start', { threadId, input: [{ type: 'text', text: '解释这段话', text_elements: [] }] })
  await response(h, 'send')
  const query = h.queries[0]!
  expect(query.options?.persistSession).toBe(false)
  request(h, 'busy', 'thread/unsubscribe', { threadId })
  expect(await response(h, 'busy')).toHaveProperty('error')
  expect(query.closed).toBe(false)
  query.emit({ type: 'result', subtype: 'success', usage: {} })
  await until(() => hasNote(h, 'turn/completed'))
  request(h, 'end', 'thread/unsubscribe', { threadId })
  expect((await response(h, 'end')).result).toEqual({ status: 'unsubscribed' })
  expect(query.closed).toBe(true)
  expect(note(h, 'thread/closed').params).toEqual({ threadId })
  h.bridge.shutdown()
})
