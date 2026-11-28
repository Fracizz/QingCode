import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CAPABILITIES, type ServerMessage } from '@qn/protocol'
import type { AgentHostHub } from '../codexHost'
import { createPiHost } from './host'
import type { PiRpcProcess, PiRpcOptions, RpcRecord } from './rpc'
import type { PiSessionInfo } from './sessions'

interface FakeRpc extends PiRpcProcess {
  emit(record: RpcRecord): void
  dialog(record: RpcRecord): void
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
  dialogResponses?: RpcRecord[]
}

function fakeRpc(state: FakeState): FakeRpc {
  const listeners = new Set<(record: RpcRecord) => void>()
  let onDialog: ((record: RpcRecord) => void) | undefined
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
    onDialog: (cb: (record: RpcRecord) => void) => {
      onDialog = cb
      return () => undefined
    },
    respondDialog: (response: RpcRecord) => { (state.dialogResponses ??= []).push(response) },
    releaseDialog: () => undefined,
    dialog: (record: RpcRecord) => onDialog?.(record),
    emit: (record: RpcRecord) => {
      for (const cb of [...listeners]) cb(record)
    },
  }
  return rpc as unknown as FakeRpc
}

function harness(sessions: PiSessionInfo[] = [], stateDir?: string, idleTimeoutMs?: number) {
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
    idleTimeoutMs,
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
  it('用户启动 pi 后发布真实模型，重启后可在不启动进程的情况下读取缓存', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'qn-pi-models-'))
    const h = harness([], stateDir)
    const restarted = harness([], stateDir)
    const model = { provider: 'test', id: 'model-v2', name: 'Model v2', reasoning: true, input: ['text'] }
    h.state.handleCommand = (type) => {
      if (type === 'get_available_models') return { success: true, data: { models: [model] } }
      if (type === 'get_state') return { success: true, data: { sessionId: 'fake-session', model, thinkingLevel: 'high' } }
      if (type === 'get_available_thinking_levels') return { success: true, data: { levels: ['off', 'high'] } }
    }
    try {
      await h.host.open({})
      h.host.handleClientMessage(1, { id: 1, method: 'model/list' })
      await flush()
      expect(responseFor(h.sent, 1)?.result).toMatchObject({ data: [] })
      expect(h.rpcOptions).toHaveLength(0)

      h.host.handleClientMessage(1, { id: 2, method: 'thread/start', params: { cwd: '/work' } })
      await flush()
      expect(h.broadcasts.some(({ msg }) => msg.method === 'qingcode/models/updated')).toBe(true)

      await restarted.host.open({})
      restarted.host.handleClientMessage(1, { id: 3, method: 'model/list' })
      await flush()
      expect(responseFor(restarted.sent, 3)?.result).toMatchObject({
        data: [{ model: 'test/model-v2', displayName: 'Model v2', isDefault: true, defaultReasoningEffort: 'high' }],
      })
      expect(restarted.rpcOptions).toHaveLength(0)
    } finally {
      h.host.shutdown()
      restarted.host.shutdown()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

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

  it('当前轮已写入 pi 历史时仍只允许从上一轮分支', async () => {
    const threadId = 'fake-session'
    const { host, sent, rpc, state } = harness([
      { meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' },
    ])
    const activeUser = { role: 'user', content: '正在运行', timestamp: 3000 }
    state.messages = [
      { role: 'user', content: '已结束', timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: 2000 },
      activeUser,
      { role: 'assistant', content: [], stopReason: 'toolUse', timestamp: 4000 },
    ]
    try {
      await host.open({})
      host.handleClientMessage(1, {
        id: 1, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: '正在运行' }] },
      })
      await flush()
      const { turn } = responseFor(sent, 1)?.result as { turn: { id: string } }
      rpc().emit({ type: 'message_start', message: activeUser })
      host.handleClientMessage(1, {
        id: 2, method: 'thread/turns/list', params: { threadId, sortDirection: 'desc', itemsView: 'notLoaded' },
      })
      await flush()
      expect(responseFor(sent, 2)?.result).toMatchObject({ data: [
        { id: turn.id, status: 'inProgress' }, { id: 'turn-fake-session-0', status: 'completed' },
      ] })

      host.handleClientMessage(1, { id: 3, method: 'thread/fork', params: { threadId, lastTurnId: 'turn-fake-session-2' } })
      await flush()
      expect(responseFor(sent, 3)?.error).toMatchObject({ code: -32602 })
      expect(state.commands).not.toContain('clone')

      state.handleCommand = (type, payload) => {
        if (type === 'get_entries') return { success: true, data: {
          leafId: 'active', entries: [{ id: 'active', type: 'message', message: activeUser }],
        } }
        if (type === 'fork') {
          expect(payload).toEqual({ entryId: 'active' })
          return { success: true }
        }
        if (type === 'get_state' && state.commands.includes('fork')) {
          return { success: true, data: { sessionId: 'pi-branch', sessionFile: '/tmp/pi-branch.jsonl' } }
        }
      }
      host.handleClientMessage(1, {
        id: 4, method: 'thread/fork', params: { threadId, lastTurnId: 'turn-fake-session-0', excludeTurns: true },
      })
      await flush()
      expect(responseFor(sent, 4)?.result).toMatchObject({ thread: { id: 'pi-branch', turns: [] } })
      expect(host.activeTurns).toBe(1)
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
      const result = responseFor(sent, 1)?.result as { turn: { id: string; items: RpcRecord[] } }
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
          { id: result.turn.id, status: 'inProgress', items: [{ ...echo, id: result.turn.items[0]?.id }] },
        ] },
      })
      rpc().emit({ type: 'agent_settled' })
      host.handleClientMessage(2, { id: 3, method: 'thread/read', params: { threadId } })
      await flush()
      expect(responseFor(sent, 3)?.result).toMatchObject({
        thread: { turns: [
          { status: 'completed', items: [{ ...echo, id: 'turn-fake-session-0-user', clientId: null }] },
          { status: 'completed', items: [{ ...echo, id: result.turn.items[0]?.id }] },
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
      expect(state.commands).toEqual(['switch_session', 'get_state', 'get_available_models', 'compact'])
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
    expect(state.commands).toEqual(['switch_session', 'get_state', 'get_available_models', 'get_messages', 'get_session_stats'])
    host.shutdown()
  })

  it('codex.open 返回 initialize:null、agentVersion 与 capabilities', async () => {
    const { host, state } = harness()
    const opened = await host.open({})
    expect(opened.initialize).toBeNull()
    expect(opened.agentVersion).toBe('1.6.1')
    expect(opened.lastSeq).toBe(0)
    expect((opened as { capabilities?: unknown }).capabilities).toEqual(AGENT_CAPABILITIES.pi)
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
    expect(state.commands).toEqual(['switch_session', 'switch_session', 'get_state', 'get_available_models', 'get_messages', 'get_messages'])
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

describe('PiHost 扩展对话框、改名、技能与上下文占用', () => {
  const threadId = 'fake-session'
  const sessions = [{ meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' }]
  const start = async () => {
    const h = harness(sessions)
    const request = (id: number, method: string, params: RpcRecord = {}) =>
      h.host.handleClientMessage(1, { id, method, params: { threadId, ...params } })
    await h.host.open({})
    request(1, 'turn/start', { input: [{ type: 'text', text: '问' }] })
    await flush()
    const turnId = (responseFor(h.sent, 1)?.result as { turn: { id: string } }).turn.id
    const method = (name: string) => h.broadcasts.filter(({ msg }) => msg.method === name).map(({ msg }) => msg)
    return { ...h, request, turnId, method }
  }

  it('对话框作为提问交给用户，回答写回 pi 并撤掉卡片', async () => {
    const h = await start()
    h.rpc().dialog({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: '继续？' })
    const asked = h.method('item/tool/requestUserInput')[0]!
    expect(asked.params).toMatchObject({ threadId, turnId: h.turnId })
    expect(h.state.dialogResponses).toBeUndefined()
    h.host.handleClientMessage(1, { id: asked.id, result: { answers: { q0: { answers: ['是'] } } } })
    await flush()
    expect(h.state.dialogResponses).toEqual([{ type: 'extension_ui_response', id: 'ui-1', confirmed: true }])
    expect(h.method('serverRequest/resolved')[0]?.params).toMatchObject({ requestId: asked.id })
    h.host.shutdown()
  })

  it('停止本轮时取消未回答的对话框', async () => {
    const h = await start()
    h.rpc().dialog({ type: 'extension_ui_request', id: 'ui-2', method: 'input', title: '输入' })
    h.request(2, 'turn/interrupt')
    await flush()
    expect(h.state.dialogResponses).toEqual([{ type: 'extension_ui_response', id: 'ui-2', cancelled: true }])
    expect(h.method('serverRequest/resolved')).toHaveLength(1)
    h.host.shutdown()
  })

  it('经官方 RPC 改名、列技能并上报上下文占用', async () => {
    const h = await start()
    h.state.handleCommand = (type) => {
      if (type === 'get_commands') {
        return { success: true, data: { commands: [
          { name: 'skill:review', description: '审查', source: 'skill', sourceInfo: { path: '/s', scope: 'project' } },
          { name: 'fix', source: 'prompt' },
        ] } }
      }
      if (type === 'get_session_stats') {
        return { success: true, data: { contextUsage: { tokens: 600, contextWindow: 2000 } } }
      }
      return undefined
    }
    h.request(2, 'thread/name/set', { name: ' 新名字 ' })
    h.request(3, 'skills/list', { cwds: ['/work'] })
    h.rpc().emit({ type: 'agent_settled' })
    await flush()
    expect(responseFor(h.sent, 2)?.result).toEqual({})
    expect(h.method('thread/name/updated')[0]?.params).toEqual({ threadId, threadName: '新名字' })
    expect(responseFor(h.sent, 3)?.result).toEqual({ data: [{ cwd: '/work', errors: [], skills: [
      { name: 'skill:review', description: '审查', path: '/s', scope: 'repo', enabled: true },
    ] }] })
    expect(h.method('thread/tokenUsage/updated').at(-1)?.params).toMatchObject({
      turnId: h.turnId, tokenUsage: { modelContextWindow: 2000, last: { totalTokens: 600 } },
    })
    h.host.shutdown()
  })
})

const running = async (idleTimeoutMs?: number) => {
  const threadId = 'fake-session'
  const h = harness(
    [{ meta: { id: threadId, cwd: '/work' }, sessionFile: '/tmp/fake-session.jsonl' }], undefined, idleTimeoutMs,
  )
  const request = (id: number, method: string, params: RpcRecord = {}) =>
    h.host.handleClientMessage(1, { id, method, params: { threadId, ...params } })
  const notes = (name: string) =>
    h.broadcasts.filter(({ msg }) => msg.method === name).map(({ msg }) => msg.params as RpcRecord)
  const turnIdOf = (id: number) => (responseFor(h.sent, id)?.result as { turn: { id: string } }).turn.id
  /** 开一轮并让 pi 开始处理首条消息。 */
  const start = async () => {
    request(1, 'turn/start', { input: [{ type: 'text', text: '问' }] })
    await flush()
    h.rpc().emit({ type: 'agent_start' })
    h.rpc().emit({ type: 'message_start', message: { role: 'user', content: '问', timestamp: 1 } })
    return turnIdOf(1)
  }
  /** 只加载会话进程，不开轮次。 */
  const load = async () => {
    request(90, 'thread/read')
    await flush()
  }
  await h.host.open({})
  return { ...h, request, notes, turnIdOf, start, load }
}

describe('PiHost 停止', () => {
  const steer = (turnId: string, clientId = 'c1') =>
    ({ expectedTurnId: turnId, input: [{ type: 'text', text: '补充' }], clientUserMessageId: clientId })
  const legacy = (type: string) =>
    type === 'clear_queue' ? { success: false, error: 'Unknown command: clear_queue' } : undefined

  it('先 clear_queue 再 abort，撤掉未送达的引导', async () => {
    const h = await running()
    const turnId = await h.start()
    h.request(2, 'turn/steer', steer(turnId))
    await flush()
    h.request(3, 'turn/interrupt')
    await flush()
    expect(responseFor(h.sent, 3)?.result).toEqual({})
    expect(h.state.commands.slice(-2)).toEqual(['clear_queue', 'abort'])
    h.rpc().emit({ type: 'agent_settled', aborted: true })
    expect(h.notes('turn/completed')).toMatchObject([{ turn: { id: turnId, status: 'interrupted' } }])
    // 撤掉的引导不能认领之后的用户消息。
    h.rpc().emit({ type: 'agent_start' })
    h.rpc().emit({ type: 'message_start', message: { role: 'user', content: '扩展消息', timestamp: 9 } })
    const echo = h.notes('item/completed').at(-1)?.item as RpcRecord
    expect(echo).toMatchObject({ type: 'userMessage', content: [{ type: 'text', text: '扩展消息' }] })
    expect(echo).not.toHaveProperty('steering')
    expect(echo.clientId ?? null).toBeNull()
    h.host.shutdown()
  })

  it.each([
    ['旧版 pi 不认识命令', (): RpcRecord => ({ success: false, error: 'Unknown command: clear_queue' })],
    ['命令超时', (): RpcRecord => { throw new Error('pi clear_queue 超时') }],
  ])('clear_queue 失败时仍发送 abort：%s', async (_name, fail) => {
    const h = await running()
    const turnId = await h.start()
    h.state.handleCommand = (type) => type === 'clear_queue' ? fail() : undefined
    h.request(2, 'turn/interrupt')
    await flush()
    expect(responseFor(h.sent, 2)?.result).toEqual({})
    expect(h.state.commands.slice(-2)).toEqual(['clear_queue', 'abort'])
    expect(h.state.closed).toBe(false)
    h.rpc().emit({ type: 'agent_settled', aborted: true })
    expect(h.notes('turn/completed')).toMatchObject([{ turn: { id: turnId, status: 'interrupted' } }])
    h.host.shutdown()
  })

  it('旧版 pi 还有未送达的引导时结束进程，避免 abort 后继续执行', async () => {
    const h = await running()
    const turnId = await h.start()
    h.state.handleCommand = legacy
    h.request(2, 'turn/steer', steer(turnId))
    await flush()
    const old = h.rpc()
    h.request(3, 'turn/interrupt')
    await flush()
    expect(h.state.commands.slice(-2)).toEqual(['clear_queue', 'abort'])
    expect(h.state.closed).toBe(true)
    expect(h.notes('turn/completed')).toMatchObject([{ turn: { id: turnId, status: 'interrupted' } }])
    // 退出中的旧进程再发事件也不能开新轮次。
    old.emit({ type: 'agent_start' })
    expect(h.notes('turn/started')).toHaveLength(1)
    expect(h.host.activeTurns).toBe(0)
    h.host.shutdown()
  })

  it('停止时等在途引导回执后再清队列，排在后面的引导退回客户端', async () => {
    const h = await running()
    const turnId = await h.start()
    const command = h.rpc().command.bind(h.rpc())
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.rpc().command = async (type, payload) => {
      const response = await command(type, payload)
      if (type === 'steer') await gate
      return response
    }
    h.request(2, 'turn/steer', steer(turnId))
    await flush()
    h.request(3, 'turn/steer', steer(turnId, 'c2'))
    h.request(4, 'turn/interrupt')
    await flush()
    expect(h.state.commands).not.toContain('clear_queue')
    release()
    await flush()
    expect(h.state.commands.slice(-3)).toEqual(['steer', 'clear_queue', 'abort'])
    expect(responseFor(h.sent, 3)?.error).toMatchObject({ code: -32602 })
    h.host.shutdown()
  })
})

describe('PiHost 非 prompt 发起的运行', () => {
  it('agent_start 建立轮次，回显用户消息并在 agent_settled 结束', async () => {
    const h = await running()
    await h.load()
    h.rpc().emit({ type: 'agent_start' })
    expect(h.host.activeTurns).toBe(1)
    const turnId = (h.notes('turn/started')[0]?.turn as { id: string }).id
    h.rpc().emit({ type: 'turn_start' })
    h.rpc().emit({ type: 'message_start', message: { role: 'user', content: '排队的消息', timestamp: 5 } })
    h.rpc().emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    h.rpc().emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '续跑回答' }] } })
    // 一次底层运行结束后可能还有续跑，只有 agent_settled 收尾。
    h.rpc().emit({ type: 'agent_end', messages: [], willRetry: false })
    h.rpc().emit({ type: 'agent_start' })
    expect(h.host.activeTurns).toBe(1)
    h.rpc().emit({ type: 'agent_settled', aborted: false })
    expect(h.notes('turn/started')).toHaveLength(1)
    expect(h.notes('turn/completed')).toMatchObject([{ turn: { id: turnId, status: 'completed', items: [
      { type: 'userMessage', id: `${turnId}-user` }, { type: 'agentMessage', text: '续跑回答' },
    ] } }])
    expect(h.host.activeTurns).toBe(0)
    // 重读历史沿用实时事件里的用户条目 ID。
    h.state.messages = [{ role: 'user', content: '排队的消息', timestamp: 5 }]
    h.request(91, 'thread/read')
    await flush()
    expect(responseFor(h.sent, 91)?.result).toMatchObject({ thread: { turns: [{ items: [{ id: `${turnId}-user` }] }] } })
    h.host.shutdown()
  })

  it('空闲期间的非运行事件不开轮次', async () => {
    const h = await running()
    await h.load()
    const custom = { role: 'custom', customType: 'note', content: '提示', display: true }
    for (const event of [
      { type: 'message_start', message: custom },
      { type: 'message_end', message: custom },
      { type: 'queue_update', steering: [], followUp: [] },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: false },
      { type: 'entry_appended', entry: {} },
      { type: 'extension_error', error: '坏了' },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled', aborted: false },
    ]) h.rpc().emit(event)
    expect(h.broadcasts).toEqual([])
    expect(h.host.activeTurns).toBe(0)
    h.host.shutdown()
  })

  it('空闲定时器不关闭自发运行中的进程，结束后重新计时', async () => {
    const h = await running(30)
    await h.load()
    h.rpc().emit({ type: 'agent_start' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.state.closed).toBe(false)
    h.rpc().emit({ type: 'agent_settled' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.state.closed).toBe(true)
    h.host.shutdown()
  })

  it('准备发送时 pi 已自行开跑，拒绝本次发送且不打断该轮', async () => {
    const h = await running()
    await h.load()
    h.state.handleCommand = (type) => {
      if (type === 'set_model') h.rpc().emit({ type: 'agent_start' })
      return undefined
    }
    h.request(2, 'turn/start', { model: 'p/m', input: [{ type: 'text', text: '问' }] })
    await flush()
    expect(responseFor(h.sent, 2)?.error).toBeDefined()
    expect(h.state.commands).not.toContain('prompt')
    expect(h.notes('turn/completed')).toEqual([])
    expect(h.host.activeTurns).toBe(1)
    h.host.shutdown()
  })

  it('prompt 回执 handled 但扩展已开跑时，本轮保持到 agent_settled', async () => {
    const h = await running()
    await h.load()
    h.state.handleCommand = (type) => {
      if (type !== 'prompt') return undefined
      h.rpc().emit({ type: 'agent_start' })
      return { success: true, data: { disposition: 'handled' } }
    }
    h.request(2, 'turn/start', { input: [{ type: 'text', text: '/kick' }] })
    await flush()
    expect(h.notes('turn/completed')).toEqual([])
    h.rpc().emit({ type: 'message_start', message: { role: 'user', content: '扩展发起', timestamp: 3 } })
    h.rpc().emit({ type: 'agent_settled' })
    expect(h.notes('turn/completed')).toMatchObject([{ turn: { id: h.turnIdOf(2), status: 'completed', items: [
      { content: [{ text: '/kick' }] }, { content: [{ text: '扩展发起' }] },
    ] } }])
    h.host.shutdown()
  })

  it('prompt 因 pi 正在运行被拒时，另建轮次接住该运行', async () => {
    const h = await running()
    await h.load()
    h.state.handleCommand = (type) => {
      if (type !== 'prompt') return undefined
      h.rpc().emit({ type: 'agent_start' })
      return { success: false, error: 'Agent is already processing' }
    }
    h.request(2, 'turn/start', { input: [{ type: 'text', text: '问' }] })
    await flush()
    expect(h.notes('turn/completed')).toMatchObject([{ turn: { id: h.turnIdOf(2), status: 'failed' } }])
    expect(h.notes('turn/started')).toHaveLength(2)
    expect(h.host.activeTurns).toBe(1)
    h.host.shutdown()
  })

  it('手动压缩结束时 pi 已在运行，接着建立轮次', async () => {
    const h = await running()
    h.state.compact = async () => {
      h.rpc().emit({ type: 'agent_start' })
      return { success: true }
    }
    h.request(2, 'thread/compact/start')
    await flush()
    expect(h.notes('turn/completed')).toHaveLength(1)
    expect(h.notes('turn/started')).toHaveLength(2)
    expect(h.host.activeTurns).toBe(1)
    h.host.shutdown()
  })
})

describe('PiHost qingcode/commands/list', () => {
  it('没有运行中的会话进程时返回空列表，不启动 pi', async () => {
    const h = await running()
    h.request(1, 'qingcode/commands/list')
    await flush()
    expect(responseFor(h.sent, 1)?.result).toEqual({ commands: [] })
    expect(h.rpcOptions).toHaveLength(0)
    h.host.shutdown()
  })

  it('经 get_commands 返回当前会话的命令', async () => {
    const h = await running()
    await h.load()
    h.state.handleCommand = (type) => type === 'get_commands' ? { success: true, data: { commands: [
      { name: 'skill:review', description: '审查', source: 'skill' },
      { name: 'fix', source: 'prompt' },
      { name: 'deploy', description: '发布', source: 'extension' },
      { description: '缺名称' },
    ] } } : undefined
    h.request(1, 'qingcode/commands/list')
    await flush()
    expect(responseFor(h.sent, 1)?.result).toEqual({ commands: [
      { name: 'skill:review', description: '审查' },
      { name: 'fix', description: '' },
      { name: 'deploy', description: '发布' },
    ] })
    h.host.handleClientMessage(1, { id: 2, method: 'qingcode/commands/list', params: {} })
    await flush()
    expect(responseFor(h.sent, 2)?.error).toMatchObject({ code: -32602 })
    h.host.shutdown()
  })
})
