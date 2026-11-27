import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@qn/protocol'
import type { AgentHostHub } from '../codexHost'
import { createPiHost } from './host'
import type { PiRpcProcess, PiRpcOptions, RpcRecord } from './rpc'
import type { PiSessionInfo } from './sessions'

interface FakeRpc extends PiRpcProcess {
  emit(record: RpcRecord): void
}

interface FakeState {
  commands: string[]
  closed: boolean
  cancelSwitch: boolean
  cancelNew: boolean
  rejectThinking?: boolean
  messages: RpcRecord[]
  compact?: () => Promise<RpcRecord>
  handleCommand?: (type: string, payload: RpcRecord) => RpcRecord | undefined
}

function fakeRpc(state: FakeState): FakeRpc {
  const listeners = new Set<(record: RpcRecord) => void>()
  const rpc = {
    running: true,
    pid: 4321,
    start: () => undefined,
    close: () => {
      state.closed = true
      ;(rpc as { running: boolean }).running = false
    },
    command: async (type: string, payload: RpcRecord = {}): Promise<RpcRecord> => {
      state.commands.push(type)
      const custom = state.handleCommand?.(type, payload)
      if (custom) return custom
      switch (type) {
        case 'new_session':
          return { type: 'response', success: true, data: { cancelled: state.cancelNew } }
        case 'get_state':
          return {
            type: 'response',
            success: true,
            data: { sessionId: 'fake-session', sessionFile: '/tmp/fake-session.jsonl' },
          }
        case 'switch_session':
          return { type: 'response', success: true, data: { cancelled: state.cancelSwitch } }
        case 'get_messages':
          return { type: 'response', success: true, data: { messages: state.messages } }
        case 'set_thinking_level':
          return { type: 'response', success: !state.rejectThinking }
        case 'prompt':
          return { type: 'response', success: true, data: { disposition: 'started' } }
        case 'compact':
          return state.compact?.() ?? { type: 'response', success: true }
        default:
          return { type: 'response', success: true, data: {} }
      }
    },
    onEvent: (cb: (record: RpcRecord) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onExit: () => () => undefined,
    emit: (record: RpcRecord) => {
      for (const cb of [...listeners]) cb(record)
    },
  }
  return rpc as unknown as FakeRpc
}

function harness(sessions: PiSessionInfo[] = [], stateDir?: string) {
  const sent: { clientId: number; msg: ServerMessage }[] = []
  const broadcasts: { seq: number; msg: RpcRecord }[] = []
  const evts: { name: string; payload: Record<string, unknown> }[] = []
  const logs: string[] = []
  const hub: AgentHostHub = {
    send: (clientId, msg) => sent.push({ clientId, msg }),
    broadcastRecv: (seq, msg) => broadcasts.push({ seq, msg: msg as RpcRecord }),
    broadcastEvt: (name, payload) => evts.push({ name, payload }),
    log: (message) => logs.push(message),
  }
  const state: FakeState = { commands: [], closed: false, cancelSwitch: false, cancelNew: false, messages: [] }
  let rpc = fakeRpc(state)
  const rpcOptions: PiRpcOptions[] = []
  const host = createPiHost(hub, '0.0.1', {
    stateDir,
    resolve: () => ({ command: 'pi', args: [], shell: false, path: 'pi', version: '1.6.1' }),
    listSessions: async () => sessions,
    createRpc: (options) => {
      rpcOptions.push(options)
      rpc = fakeRpc(state)
      return rpc
    },
  })
  return { host, sent, broadcasts, evts, logs, state, rpcOptions, rpc: () => rpc }
}

function responseFor(sent: { msg: ServerMessage }[], id: number): RpcRecord | undefined {
  const frame = sent.find(
    (entry) =>
      entry.msg.t === 'codex.recv' &&
      (entry.msg.msg as { id?: unknown })?.id === id,
  )
  return frame && frame.msg.t === 'codex.recv' ? (frame.msg.msg as RpcRecord) : undefined
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('PiHost（v2 JSON-RPC 外观）', () => {
  it('通过原生 steer 传递图片，只有 pi 开始处理引导时才写入当前轮次', async () => {
    const threadId = 'fake-session'
    const stateDir = mkdtempSync(join(tmpdir(), 'qn-pi-steering-'))
    const sessions = [
      { meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ]
    const { host, sent, broadcasts, rpc, state } = harness(sessions, stateDir)
    const restarted = harness(sessions, stateDir)
    const initial = { role: 'user', content: '第一条', timestamp: 100 }
    const supplement = { role: 'user', content: [
      { type: 'text', text: '看图' }, { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    ], timestamp: 101 }
    const input = [{ type: 'text', text: '看图', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,QUJD' }]
    state.handleCommand = (type, payload) => {
      if (type !== 'steer') return undefined
      expect(payload).toEqual({ message: '看图', images: [supplement.content[1]] })
      return { success: true, data: { disposition: 'queued' } }
    }
    const request = (id: number, method: string, params: RpcRecord) => host.handleClientMessage(1, {
      id, method, params: { threadId, ...params },
    })
    const echoes = () => broadcasts.filter(({ msg }) => msg.method === 'item/completed')
    try {
      await host.open({})
      request(1, 'turn/start', { input: [{ type: 'text', text: '第一条' }] })
      await flush()
      const turnId = (responseFor(sent, 1)?.result as { turn: { id: string } }).turn.id
      rpc().emit({ type: 'message_start', message: initial })
      request(2, 'turn/steer', { expectedTurnId: 'stale', input })
      await flush()
      expect(responseFor(sent, 2)?.error).toMatchObject({ code: -32602 })
      expect(state.commands).not.toContain('steer')

      request(3, 'turn/steer', { expectedTurnId: turnId, input, clientUserMessageId: 'steered-image' })
      await flush()
      expect(responseFor(sent, 3)?.result).toEqual({ turnId })
      expect(echoes()).toHaveLength(0)
      rpc().emit({ type: 'message_start', message: supplement })
      expect(echoes()[0]?.msg.params).toMatchObject({ turnId, item: {
        clientId: 'steered-image', steering: 'currentTurn', content: expect.arrayContaining(input),
      } })
      rpc().emit({ type: 'agent_settled' })
      expect(host.activeTurns).toBe(0)

      restarted.state.messages.push(initial, supplement)
      await restarted.host.open({})
      restarted.host.handleClientMessage(1, { id: 4, method: 'thread/read', params: { threadId } })
      await flush()
      expect(responseFor(restarted.sent, 4)?.result).toMatchObject({ thread: { turns: [{ items: [
        { type: 'userMessage' }, { clientId: 'steered-image', steering: 'currentTurn' },
      ] }] } })
    } finally {
      host.shutdown()
      restarted.host.shutdown()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it.each([
    ['turn-fake-session-0', 'fork', { entryId: 'entry-2' }, '回答一'],
    ['turn-fake-session-2', 'clone', {}, '回答二'],
  ] as const)('按 %s 创建并加载 pi 分支', async (turnId, command, payload, reply) => {
    const threadId = 'fake-session'
    const { host, sent, state, rpcOptions } = harness([
      { meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ])
    const messages = [
      { role: 'user', content: '问题一', timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }], timestamp: 2000 },
      { role: 'user', content: '问题二', timestamp: 3000 },
      { role: 'assistant', content: [{ type: 'text', text: '回答二' }], timestamp: 4000 },
    ]
    let branch = false
    state.messages = messages
    state.handleCommand = (type, args) => {
      if (type === 'get_entries') {
        const active = messages.map((message, index) => ({
          type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, message,
        }))
        return { success: true, data: {
          leafId: 'entry-3',
          entries: [...active, { id: 'abandoned', parentId: 'entry-1', type: 'message', message: messages[2] }],
        } }
      }
      if (type === command) {
        expect(args).toEqual(payload)
        branch = true
        state.messages = type === 'fork' ? messages.slice(0, 2) : messages
        return { success: true }
      }
      if (type === 'get_state' && branch) {
        return { success: true, data: { sessionId: 'pi-branch', sessionFile: '/tmp/pi-branch.jsonl' } }
      }
    }
    try {
      await host.open({})
      host.handleClientMessage(1, { id: 1, method: 'thread/fork', params: { threadId, lastTurnId: turnId } })
      await flush()
      expect(branch).toBe(true)
      expect(responseFor(sent, 1)?.result).toMatchObject({ thread: { id: 'pi-branch' } })
      const result = responseFor(sent, 1)?.result as { thread: { turns: { items: RpcRecord[] }[] } }
      expect(result.thread.turns.at(-1)?.items.at(-1)).toMatchObject({ text: reply })
      expect(state.commands).not.toContain('prompt')
      expect(state.closed).toBe(true)
      expect(rpcOptions).toHaveLength(1)
    } finally {
      host.shutdown()
    }
  })

  it('实时回显和 get_messages 识别同一次带图提交，其他相同内容保持独立', async () => {
    const threadId = 'fake-session'
    const { host, sent, broadcasts, rpc, state } = harness([
      { meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ])
    const clientId = 'client-send'
    const input = [
      { type: 'text', text: '看图', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
    ]
    const content = [
      { type: 'text', text: '看图' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' },
    ]
    try {
      await host.open({})
      host.handleClientMessage(1, {
        id: 1, method: 'turn/start', params: { threadId, input, clientUserMessageId: clientId },
      })
      await flush()
      const echo = { type: 'userMessage', id: expect.any(String), clientId, content: expect.arrayContaining(input) }
      const result = responseFor(sent, 1)?.result as { turn: { items: RpcRecord[] } }
      expect(result).toMatchObject({ turn: { items: [echo] } })
      expect(broadcasts.find(({ msg }) => msg.method === 'turn/started')?.msg.params)
        .toMatchObject({ turn: { items: [echo] } })
      const message = { role: 'user', content, timestamp: 20 }
      rpc().emit({ type: 'message_start', message })
      state.messages = [{ ...message, timestamp: 10 }, message]
      host.handleClientMessage(2, { id: 2, method: 'thread/read', params: { threadId } })
      await flush()
      expect(responseFor(sent, 2)?.result).toMatchObject({
        thread: { turns: [
          { items: [{ ...echo, id: 'turn-fake-session-0-user', clientId: null }] },
          { items: [{ ...echo, id: result.turn.items[0]?.id }] },
          { status: 'inProgress', items: [] },
        ] },
      })
    } finally {
      host.shutdown()
    }
  })

  it('手动压缩使用 pi RPC，等待期间拒绝重复压缩并播报结果', async () => {
    const threadId = 'fake-session'
    const { host, sent, broadcasts, state } = harness([
      { meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ])
    let finish!: (response: RpcRecord) => void
    state.compact = () => new Promise((resolve) => { finish = resolve })
    try {
      await host.open({})
      host.handleClientMessage(1, { id: 1, method: 'thread/compact/start', params: { threadId } })
      await flush()
      expect(responseFor(sent, 1)?.result).toEqual({})
      expect(state.commands).toEqual(['switch_session', 'get_state', 'compact'])
      expect(host.activeTurns).toBe(1)
      host.handleClientMessage(2, { id: 2, method: 'thread/compact/start', params: { threadId } })
      await flush()
      expect(responseFor(sent, 2)?.error).toMatchObject({ code: -32602 })
      finish({ type: 'response', success: false, error: '上下文太短' })
      await flush()
      expect(host.activeTurns).toBe(0)
      expect(broadcasts.map(({ msg }) => msg)).toContainEqual(expect.objectContaining({
        method: 'turn/completed', params: expect.objectContaining({
          threadId, turn: expect.objectContaining({ status: 'failed', items: [expect.objectContaining({
            type: 'contextCompaction', status: 'failed',
          })] }),
        }),
      }))
    } finally {
      host.shutdown()
    }
  })

  it('只读元数据不开进程，历史分页复用 get_messages 快照', async () => {
    const threadId = 'fake-session'
    const { host, sent, state, rpcOptions } = harness([
      { meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ])
    state.messages = [0, 1, 2].flatMap((index) => [
      { role: 'user', content: `问题 ${index}` },
      { role: 'assistant', content: [{ type: 'text', text: `回答 ${index}` }] },
    ])
    await host.open({})
    host.handleClientMessage(1, { id: 1, method: 'thread/read', params: { threadId, includeTurns: false } })
    await flush()
    expect(responseFor(sent, 1)?.result).toMatchObject({
      thread: { id: threadId, historyMode: 'paginated', turns: [] },
    })
    expect(rpcOptions).toHaveLength(0)

    const params = { threadId, sortDirection: 'desc', itemsView: 'full', limit: 1 }
    host.handleClientMessage(1, { id: 2, method: 'thread/turns/list', params })
    await flush()
    const latest = responseFor(sent, 2)?.result as RpcRecord
    expect(latest).toMatchObject({
      data: [{ id: 'turn-fake-session-4', items: [{ type: 'userMessage' }, { type: 'agentMessage', text: '回答 2' }] }],
      nextCursor: expect.any(String),
    })
    host.handleClientMessage(1, { id: 3, method: 'thread/turns/list', params: { ...params, cursor: latest.nextCursor } })
    await flush()
    expect(responseFor(sent, 3)?.result).toMatchObject({
      data: [{ id: 'turn-fake-session-2' }],
      nextCursor: expect.any(String),
    })
    expect(state.commands).toEqual(['switch_session', 'get_state', 'get_messages'])
    host.shutdown()
  })

  it('codex.open 返回 initialize:null、agentVersion 与 capabilities', async () => {
    const { host, state } = harness()
    const opened = await host.open({})
    expect(opened.initialize).toBeNull()
    expect(opened.agentVersion).toBe('1.6.1')
    expect(opened.lastSeq).toBe(0)
    expect((opened as { capabilities?: unknown }).capabilities).toEqual({
      approvals: false,
      rateLimits: false,
      ephemeralNoTools: true,
    })
    // 打开阶段只做 --version 探测，不开会话、不发 prompt。
    expect(state.commands).toEqual([])
    expect(host.status()).toMatchObject({ running: true, activeTurns: 0 })
  })

  it('thread/start → turn/start → 事件 → turn/completed，且广播带 seq', async () => {
    const { host, sent, broadcasts, rpc } = harness([
      { meta: { id: 'fake-session', cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ])
    await host.open({})
    host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work' } })
    await flush()
    const started = responseFor(sent, 1)
    const threadId = ((started?.result as { thread?: { id?: string } })?.thread?.id) ?? ''
    expect(threadId).toBe('fake-session')
    expect((started?.result as { approvalPolicy?: string })?.approvalPolicy).toBe('never')

    host.handleClientMessage(1, {
      id: 2,
      method: 'turn/start',
      params: { threadId, input: [{ type: 'text', text: '你好', text_elements: [] }] },
    })
    await flush()
    expect(broadcasts.some((entry) => entry.msg.method === 'turn/started')).toBe(true)
    expect(host.activeTurns).toBe(1)
    host.handleClientMessage(2, { id: 10, method: 'thread/list', params: { cwd: '/work' } })
    host.handleClientMessage(2, { id: 11, method: 'thread/read', params: { threadId } })
    await flush()
    expect(responseFor(sent, 10)?.result).toMatchObject({ data: [{ id: threadId, status: { type: 'active', activeFlags: [] } }] })
    expect(responseFor(sent, 11)?.result).toMatchObject({
      thread: { status: { type: 'active', activeFlags: [] }, turns: [{ status: 'inProgress' }] },
    })

    rpc().emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    rpc().emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    })
    rpc().emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好' },
    })
    rpc().emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '你好' },
    })
    rpc().emit({ type: 'agent_settled', aborted: false })

    expect(broadcasts.some((entry) => entry.msg.method === 'item/agentMessage/delta')).toBe(true)
    const completed = broadcasts.find((entry) => entry.msg.method === 'turn/completed')
    expect((completed?.msg.params as { turn?: { status?: string } })?.turn?.status).toBe('completed')
    expect(host.activeTurns).toBe(0)
    expect(broadcasts.every((entry) => typeof entry.seq === 'number' && entry.seq > 0)).toBe(true)
  })

  it('不支持的 v2 方法返回 -32601，且不生成审批请求', async () => {
    const { host, sent, broadcasts } = harness()
    await host.open({})
    host.handleClientMessage(1, { id: 9, method: 'account/rateLimits/read', params: {} })
    await flush()
    expect((responseFor(sent, 9)?.error as { code?: number })?.code).toBe(-32601)
    expect(broadcasts.some((entry) => String(entry.msg.method).includes('requestApproval'))).toBe(false)
  })

  it('思考档切换失败不发送 prompt，重试保留已切换的模型', async () => {
    const { host, sent, broadcasts, state } = harness()
    await host.open({})
    host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work' } })
    await flush()
    const thread = (responseFor(sent, 1)?.result as { thread: { id: string } }).thread
    const params = { threadId: thread.id, model: 'provider/model', effort: 'high', input: [{ type: 'text', text: '你好' }] }
    state.rejectThinking = true
    host.handleClientMessage(1, { id: 2, method: 'turn/start', params })
    await flush()
    expect(responseFor(sent, 2)?.error).toMatchObject({ message: expect.stringContaining('消息未发送') })
    expect(state.commands).not.toContain('prompt')
    expect(broadcasts.some(({ msg }) => msg.method === 'turn/started')).toBe(false)
    expect(host.activeTurns).toBe(0)

    state.rejectThinking = false
    host.handleClientMessage(1, { id: 3, method: 'turn/start', params })
    await flush()
    expect(responseFor(sent, 3)).toHaveProperty('result.turn.status', 'inProgress')
    expect(state.commands.filter((name) => name === 'set_model')).toHaveLength(1)
    expect(state.commands.filter((name) => name === 'set_thinking_level')).toHaveLength(2)
    expect(state.commands.filter((name) => name === 'prompt')).toHaveLength(1)
    host.shutdown()
  })

  it('thread/list 与 thread/read 走只读会话解析 / switch_session + get_messages', async () => {
    const { host, sent, state } = harness([
      {
        meta: { id: 'fake-session', cwd: '/work', preview: '列出当前目录' },
        sessionFile: '/tmp/fake-session.jsonl',
      },
    ])
    await host.open({})
    host.handleClientMessage(1, { id: 3, method: 'thread/list', params: { cwd: '/work' } })
    await flush()
    const listed = (responseFor(sent, 3)?.result as { data?: { id: string }[] })?.data
    expect(listed).toHaveLength(1)
    expect(listed?.[0]?.id).toBe('fake-session')

    host.handleClientMessage(1, { id: 4, method: 'thread/read', params: { threadId: 'fake-session' } })
    await flush()
    expect((responseFor(sent, 4)?.result as { thread?: { id?: string } })?.thread?.id).toBe(
      'fake-session',
    )
    expect(state.commands).toContain('switch_session')
    expect(state.commands).toContain('get_messages')
  })

  it('未列过会话时也能按 ID 恢复，取消切换后允许重试', async () => {
    const { host, sent, state, rpcOptions } = harness([
      { meta: { id: 'fake-session', cwd: '/other/project', preview: '历史' }, sessionFile: '/tmp/old.jsonl' },
    ])
    await host.open({})

    state.cancelSwitch = true
    host.handleClientMessage(1, { id: 1, method: 'thread/resume', params: { threadId: 'fake-session' } })
    await flush()
    expect(responseFor(sent, 1)?.error).toMatchObject({ message: '切换到 pi 历史会话失败' })
    expect(state.commands).toEqual(['switch_session'])
    expect(state.closed).toBe(true)

    state.cancelSwitch = false
    host.handleClientMessage(1, { id: 2, method: 'thread/read', params: { threadId: 'fake-session' } })
    host.handleClientMessage(2, { id: 3, method: 'thread/resume', params: { threadId: 'fake-session' } })
    await flush()
    expect(responseFor(sent, 2)?.result).toMatchObject({ thread: { id: 'fake-session', cwd: '/other/project' } })
    expect(responseFor(sent, 3)?.result).toEqual(responseFor(sent, 2)?.result)
    expect(state.commands).toEqual(['switch_session', 'switch_session', 'get_state', 'get_messages', 'get_messages'])
    expect(rpcOptions.map((options) => options.cwd)).toEqual(['/other/project', '/other/project'])

    host.handleClientMessage(1, { id: 4, method: 'thread/read', params: { threadId: 'missing' } })
    await flush()
    expect(responseFor(sent, 4)?.error).toMatchObject({ message: '未找到 pi 会话' })
    expect(rpcOptions).toHaveLength(2)
    host.shutdown()
  })

  it('shutdown 结束全部 pi 子进程', async () => {
    const { host, state } = harness()
    await host.open({})
    host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work' } })
    await flush()
    host.shutdown()
    expect(state.closed).toBe(true)
    expect(host.status().running).toBe(false)
  })
})

it('临时侧聊禁用工具，结束后关闭对应 RPC 进程', async () => {
  const { host, sent, broadcasts, state, rpcOptions } = harness()
  await host.open({})
  host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work', ephemeral: true } })
  await flush()
  expect(rpcOptions[0]?.extraArgs).toEqual(['--no-session', '--no-tools', '--no-extensions'])
  host.handleClientMessage(1, { id: 2, method: 'thread/unsubscribe', params: { threadId: 'fake-session' } })
  await flush()
  expect(responseFor(sent, 2)?.result).toEqual({ status: 'unsubscribed' })
  expect(state.closed).toBe(true)
  expect(broadcasts.some(({ msg }) => msg.method === 'thread/closed')).toBe(true)
})

it('pi 取消创建临时会话时释放待建进程，允许重试', async () => {
  const { host, state, sent } = harness()
  await host.open({})
  state.cancelNew = true
  host.handleClientMessage(1, { id: 1, method: 'thread/start', params: { cwd: '/work', ephemeral: true } })
  await flush()
  expect(responseFor(sent, 1)).toHaveProperty('error')
  expect(state.closed).toBe(true)
  state.cancelNew = false
  host.handleClientMessage(1, { id: 2, method: 'thread/start', params: { cwd: '/work', ephemeral: true } })
  await flush()
  expect(responseFor(sent, 2)?.result).toHaveProperty('thread.id', 'fake-session')
  host.shutdown()
})
