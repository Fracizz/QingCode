/**
 * bridge 层端到端：注入假的 query 工厂，跑 open → thread/start → turn/start → delta
 * → approval → turn/completed → interrupt，同时验证 seq/回放与 agent host 的中继规则。
 */
import type { Options, PermissionMode, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerMessage } from '@qn/protocol'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentHostError, type AgentHostHub } from '../codexHost'
import { AsyncQueue, ClaudeBridge, type ClaudeDeps, type QueryLike } from './bridge'
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

function harness(options: { failResolve?: boolean; listSessions?: ClaudeDeps['listSessions'] } = {}): Harness {
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
    getSessionMessages: async () => [
      {
        message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '历史问题' }] },
      },
      {
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '历史回答' }] },
      },
    ],
  }
  const bridge = new ClaudeBridge(hub, '0.0.1', {
    deps,
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
    const h = harness()
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
