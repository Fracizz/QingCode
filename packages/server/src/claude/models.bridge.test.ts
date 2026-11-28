/**
 * 模型选择全链路（假 Query）：无会话只读静态别名、真实表缓存、新会话 options、
 * 已有会话 setModel / applyFlagSettings、serviceTier 忽略、thread/read 带当前配置。
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ServerMessage } from '@qn/protocol'
import { describe, expect, it } from 'vitest'
import type { AgentHostHub } from '../codexHost'
import { AsyncQueue, ClaudeBridge, type ClaudeDeps, type QueryLike } from './bridge'
import type { Json } from './v2'

const SDK_MODELS = [
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'Most capable',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    supportsFastMode: true,
  },
  { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fast' },
]

class ModelQuery implements QueryLike {
  readonly messages = new AsyncQueue<unknown>()
  readonly setModelCalls: (string | undefined)[] = []
  readonly flagCalls: Record<string, unknown>[] = []
  rejectEffort = false
  modelReads = 0
  constructor(
    readonly prompt: unknown,
    readonly options: Options | undefined,
    private readonly failModels: boolean,
  ) {}

  emit(msg: unknown): void {
    this.messages.push(msg)
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.messages[Symbol.asyncIterator]()
  }

  async supportedModels(): Promise<unknown[]> {
    this.modelReads += 1
    if (this.failModels) throw new Error('模型表不可用')
    return SDK_MODELS
  }

  async setModel(model?: string): Promise<void> {
    this.setModelCalls.push(model)
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    this.flagCalls.push(settings)
    if (this.rejectEffort) throw new Error('强度不适用')
  }

  async interrupt(): Promise<void> {}

  close(): void {
    this.messages.close()
  }
}

interface Harness {
  bridge: ClaudeBridge
  sent: { clientId: number; msg: ServerMessage }[]
  recv: { seq: number; msg: Json }[]
  logs: string[]
  queries: ModelQuery[]
}

function harness(options: { failModels?: boolean } = {}): Harness {
  const sent: Harness['sent'] = []
  const recv: Harness['recv'] = []
  const logs: string[] = []
  const queries: ModelQuery[] = []
  const hub: AgentHostHub = {
    send: (clientId, msg) => sent.push({ clientId, msg }),
    broadcastRecv: (seq, msg) => recv.push({ seq, msg: msg as Json }),
    broadcastEvt: () => {},
    log: (message) => logs.push(message),
  }
  const deps: ClaudeDeps = {
    query: (params) => {
      const query = new ModelQuery(params.prompt, params.options, options.failModels === true)
      queries.push(query)
      return query
    },
    listSessions: async () => [],
    getSessionMessages: async () => [],
  }
  const bridge = new ClaudeBridge(hub, '0.0.1', {
    deps,
    resolve: () => ({ path: 'C:/fake/claude.exe', version: '2.1.331' }),
    idleTimeoutMs: 60_000,
  })
  return { bridge, sent, recv, logs, queries }
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
  throw new Error(`等待响应 ${id} 超时`)
}

function notes(h: Harness, method: string): Json[] {
  return h.recv.filter((entry) => entry.msg.method === method).map((entry) => entry.msg)
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

function textInput(text = 'hi'): Json[] {
  return [{ type: 'text', text, text_elements: [] }]
}

describe('Claude 模型/强度选择（桥层）', () => {
  it('无活动会话只返回别名列表，不创建 query；会话开启后返回并缓存 SDK 真实列表', async () => {
    const h = harness()
    await h.bridge.open({})

    request(h, 'm-static', 'model/list')
    const first = ((await response(h, 'm-static')).result ?? {}) as Json
    expect((first.data as Json[]).map((row) => row.model)).toEqual([
      'default',
      'sonnet',
      'opus',
      'haiku',
      'sonnet[1m]',
      'opusplan',
    ])
    expect(first.nextCursor).toBeNull()
    expect(h.queries).toHaveLength(0)

    request(h, 't-start', 'thread/start', { cwd: '/work', model: 'sonnet', effort: 'high' })
    const started = ((await response(h, 't-start')).result ?? {}) as Json
    const threadId = (started.thread as Json).id as string
    expect(started).toMatchObject({ model: 'sonnet', reasoningEffort: 'high' })
    expect(started.thread).toMatchObject({ model: 'sonnet', reasoningEffort: 'high' })
    await until(() => notes(h, 'thread/started').length === 1)
    expect(notes(h, 'thread/started')[0]?.params).toMatchObject({
      thread: { model: 'sonnet', reasoningEffort: 'high' },
    })

    request(h, 'turn-1', 'turn/start', {
      threadId,
      input: textInput(),
      model: 'opus',
      effort: 'xhigh',
      serviceTier: 'fast',
    })
    expect(((await response(h, 'turn-1')).result as Json).turn).toMatchObject({ status: 'inProgress' })
    const query = h.queries[0]
    expect(h.queries).toHaveLength(1)
    expect(query?.options?.model).toBe('opus')
    expect(query?.options?.effort).toBe('xhigh')
    // serviceTier 不支持，不能偷偷写进 settings/fastMode。
    expect(query?.options?.settings).toBeUndefined()
    await until(() => notes(h, 'turn/started').length === 1)
    expect(notes(h, 'turn/started')[0]?.params).toMatchObject({
      model: 'opus',
      reasoningEffort: 'xhigh',
    })

    // supportedModels() 在用户自己开启的会话上读取一次，之后按 daemon 生命周期缓存。
    await sleep(20)
    request(h, 'm-real', 'model/list')
    const real = ((await response(h, 'm-real')).result ?? {}) as Json
    const rows = real.data as Json[]
    expect(rows.map((row) => row.model)).toEqual(['claude-opus-4-6', 'claude-haiku-4-5'])
    expect(rows[0]?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: 'low', description: '' },
      { reasoningEffort: 'medium', description: '' },
      { reasoningEffort: 'high', description: '' },
      { reasoningEffort: 'max', description: '' },
    ])
    expect(rows[0]?.serviceTiers).toEqual([])
    expect(query?.modelReads).toBe(1)
    // 拿到真实表后广播一次，客户端据此替换会话开启前缓存的别名列表。
    expect(notes(h, 'qingcode/models/updated')).toHaveLength(1)

    request(h, 'm-cached', 'model/list')
    const cached = ((await response(h, 'm-cached')).result ?? {}) as Json
    expect(cached.data).toEqual(real.data)
    expect(query?.modelReads).toBe(1)

    request(h, 'r-read', 'thread/read', { threadId })
    const read = ((await response(h, 'r-read')).result ?? {}) as Json
    expect(read.thread).toMatchObject({ model: 'opus', reasoningEffort: 'xhigh' })

    h.bridge.shutdown()
  }, 10_000)

  it('已有会话用 setModel / applyFlagSettings({effortLevel}) 切换，忽略 serviceTier', async () => {
    const h = harness()
    await h.bridge.open({})
    request(h, 't0', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 't0')).result as Json).thread as Json).id as string

    request(h, 'turn-a', 'turn/start', { threadId, input: textInput('第一句'), model: 'sonnet', effort: 'medium' })
    await response(h, 'turn-a')
    const query = h.queries[0]
    expect(query?.options?.model).toBe('sonnet')
    expect(query?.options?.effort).toBe('medium')

    query?.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      result: '好',
    })
    await until(() => notes(h, 'turn/completed').length === 1)

    request(h, 'turn-b', 'turn/start', {
      threadId,
      input: textInput('第二句'),
      model: 'haiku',
      effort: 'low',
      serviceTier: 'fast',
    })
    await response(h, 'turn-b')
    expect(h.queries).toHaveLength(1)
    expect(query?.setModelCalls).toEqual(['haiku'])
    expect(query?.flagCalls).toEqual([{ effortLevel: 'low' }])
    expect(notes(h, 'turn/started').at(-1)?.params).toMatchObject({ model: 'haiku', reasoningEffort: 'low' })

    // 选回 default 等价于 setModel(undefined)，未变的强度不再下发。
    query?.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: {},
      total_cost_usd: 0,
      result: '好',
    })
    await until(() => notes(h, 'turn/completed').length === 2)
    request(h, 'turn-c', 'turn/start', { threadId, input: textInput('第三句'), model: 'default' })
    await response(h, 'turn-c')
    expect(query?.setModelCalls).toEqual(['haiku', undefined])
    expect(query?.flagCalls).toEqual([{ effortLevel: 'low' }])
    expect(notes(h, 'turn/started').at(-1)?.params).toMatchObject({ model: null, reasoningEffort: 'low' })
    h.bridge.shutdown()
  }, 10_000)

  it('强度切换失败保留已应用的模型，且消息只在用户重试成功后发送', async () => {
    const h = harness()
    await h.bridge.open({})
    request(h, 'thread', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 'thread')).result as Json).thread as Json).id as string
    request(h, 'first', 'turn/start', { threadId, input: textInput('第一句'), model: 'sonnet', effort: 'medium' })
    await response(h, 'first')
    const query = h.queries[0]!
    query.emit({ type: 'result', subtype: 'success', is_error: false })
    await until(() => notes(h, 'turn/completed').length === 1)

    const next = { threadId, input: textInput('第二句'), model: 'opus', effort: 'high' }
    query.rejectEffort = true
    request(h, 'rejected', 'turn/start', next)
    expect(await response(h, 'rejected')).toHaveProperty('error.message', 'Claude 切换推理强度失败，消息未发送')
    expect(notes(h, 'turn/started')).toHaveLength(1)
    expect(h.bridge.activeTurns).toBe(0)
    request(h, 'read', 'thread/read', { threadId, includeTurns: false })
    expect(await response(h, 'read')).toHaveProperty('result.thread', expect.objectContaining({ model: 'opus', reasoningEffort: 'medium' }))

    query.rejectEffort = false
    request(h, 'retry', 'turn/start', next)
    expect(await response(h, 'retry')).toHaveProperty('result.turn.status', 'inProgress')
    expect(query.setModelCalls).toEqual(['opus'])
    expect(query.flagCalls).toEqual([{ effortLevel: 'high' }, { effortLevel: 'high' }])
    expect(notes(h, 'turn/started').at(-1)?.params).toMatchObject({ model: 'opus', reasoningEffort: 'high' })
    h.bridge.shutdown()
  })

  it('supportedModels() 失败时回退别名列表，且绝不为探测额外创建 query', async () => {
    const h = harness({ failModels: true })
    await h.bridge.open({})
    request(h, 't0', 'thread/start', { cwd: '/work' })
    const threadId = (((await response(h, 't0')).result as Json).thread as Json).id as string
    request(h, 'turn0', 'turn/start', { threadId, input: textInput() })
    await response(h, 'turn0')
    await sleep(20)
    request(h, 'm0', 'model/list')
    const list = ((await response(h, 'm0')).result ?? {}) as Json
    expect((list.data as Json[])[0]?.model).toBe('default')
    expect(h.queries).toHaveLength(1)
    expect(h.logs.some((line) => line.includes('模型表读取失败'))).toBe(true)
    h.bridge.shutdown()
  }, 10_000)
})
