// 浏览器开发模式：无 window.QnNative 时用内存假数据把全部页面点通（不触网、不打印凭据）。
import { buildConnectionInfo, normalizeFingerprint } from './link'
import type { NativeCallbacks, NativePort } from './native'
import type { GatewayEvent, Project, Target } from './types'

export const MOCK_FP = '0123456789abcdef'.repeat(4)
export const MOCK_CODE = 'mock1234'
export const MOCK_HOST = '192.168.10.87'
export const MOCK_PORT = 38500
export const MOCK_DEVICE = '模拟电脑'
export const MOCK_TOKEN = 'mock-token'

export const MOCK_SAMPLE_TEXT = buildConnectionInfo({
  host: MOCK_HOST,
  port: MOCK_PORT,
  fp: MOCK_FP,
  name: MOCK_DEVICE,
  code: MOCK_CODE,
}).text

const STORAGE_PREFIX = 'qn-mobile-mock:'
const SECOND = 1000

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

class MockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MockError'
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

const MOCK_TARGETS: Target[] = [
  { id: 'local', kind: 'local', name: '本机' },
  {
    id: 'ssh-93',
    kind: 'ssh',
    name: '验收机 93',
    host: '192.168.10.93',
    port: 22,
    username: 'root',
    auth: { kind: 'password' },
  },
]

const MOCK_PROJECTS: Project[] = [
  {
    id: 'p-local',
    targetId: 'local',
    name: 'qingcode-next',
    path: 'D:\\code\\qingcode-next',
    lastOpenedAt: Date.now(),
  },
  { id: 'p-93', targetId: 'ssh-93', name: 'srv', path: '/root/srv', lastOpenedAt: Date.now() - 86_400_000 },
]

type Stream = { id: string; heartbeat: ReturnType<typeof setInterval> | null }

export class MockNativePort implements NativePort {
  private readonly streams = new Map<string, Stream>()
  private readonly memory = new Map<string, string>()
  private readonly projects: Project[] = [...MOCK_PROJECTS]
  private readonly threads: JsonRecord[] = [
    {
      id: 't-demo',
      preview: '帮我看看这个项目',
      name: '示例会话',
      cwd: 'D:\\code\\qingcode-next',
      updatedAt: Math.floor(Date.now() / SECOND),
    },
  ]
  private seq = 0
  private counter = 0
  private nextStream = 1

  constructor(private readonly hub: NativeCallbacks) {}

  request(json: string): string {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(json) as unknown
    } catch {
      parsed = null
    }
    const request = isRecord(parsed) ? parsed : {}
    const id = typeof request.id === 'number' ? request.id : 0
    const method = str(request.method)
    const params = isRecord(request.params) ? request.params : {}
    // 与原生桥一致：先回 ack，再异步投递结果。
    setTimeout(() => this.dispatch(id, method, params), 10)
    return JSON.stringify({ id, queued: true })
  }

  private dispatch(id: number, method: string, params: JsonRecord): void {
    try {
      this.reply(id, this.handle(method, params))
    } catch (err) {
      const code = err instanceof MockError ? err.code : 'internal'
      const message = err instanceof Error ? err.message : '模拟网关请求失败'
      this.replyError(id, code, message)
    }
  }

  private handle(method: string, params: JsonRecord): unknown {
    switch (method) {
      case 'probe':
        return { fingerprint: MOCK_FP, name: MOCK_DEVICE, version: '0.0.1', protocol: 1 }
      case 'pair': {
        const code = str(params.code)
        const fp = normalizeFingerprint(params.fp)
        if (fp !== MOCK_FP) {
          throw new MockError('fingerprint', '地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息')
        }
        if (code !== MOCK_CODE) throw new MockError('unauthorized', '配对密码错误（模拟密码：mock1234）')
        return { token: MOCK_TOKEN, desktopName: MOCK_DEVICE }
      }
      case 'rpc':
        return this.handleRpc(params)
      case 'events.open': {
        const id = `s${this.nextStream++}`
        const stream: Stream = { id, heartbeat: null }
        this.streams.set(id, stream)
        stream.heartbeat = setInterval(() => this.emit({ name: 'ping' }), 20_000)
        this.emit({ name: 'ping', payload: { mock: true } })
        return id
      }
      case 'events.close': {
        const id = str(params.stream)
        this.closeStream(id, null)
        return { closed: true }
      }
      case 'clipboard.read':
        return MOCK_SAMPLE_TEXT
      case 'storage.get':
        return this.readStorage(str(params.key))
      case 'storage.set': {
        const key = str(params.key)
        const value = params.value
        this.writeStorage(key, value === null || value === undefined ? null : String(value))
        return { ok: true }
      }
      default:
        throw new MockError('unsupported', '不支持的原生方法')
    }
  }

  private handleRpc(request: JsonRecord): unknown {
    const method = str(request.method)
    const params = isRecord(request.params) ? request.params : {}
    switch (method) {
      case 'targets.list':
        return MOCK_TARGETS
      case 'target.connect':
        this.scheduleTargetStates(str(params.id))
        return null
      case 'target.disconnect':
        this.emit({ name: 'target.state', payload: { id: str(params.id), state: 'idle' } })
        return null
      case 'projects.list': {
        const targetId = str(params.targetId)
        return targetId ? this.projects.filter((p) => p.targetId === targetId) : [...this.projects]
      }
      case 'projects.save': {
        const targetId = str(params.targetId)
        const path = str(params.path)
        if (!targetId || !path) throw new MockError('invalid_params', '缺少目标或路径')
        const existing = this.projects.find((p) => p.id === params.id)
        const project: Project = existing
          ? { ...existing, path, name: str(params.name, existing.name), lastOpenedAt: Date.now() }
          : {
              id: `p-${++this.counter}`,
              targetId,
              name: str(params.name) || basename(path),
              path,
              lastOpenedAt: Date.now(),
            }
        if (!existing) this.projects.push(project)
        return project
      }
      case 'server.req':
        return this.serverReq(params)
      case 'codex.send': {
        this.codexSend(params)
        return null
      }
      case 'target.forgetSecret':
      case 'hostKey.respond':
        return null
      default:
        throw new MockError('gateway', '该方法不在手机网关白名单内')
    }
  }

  private serverReq(params: JsonRecord): unknown {
    const method = str(params.method)
    const inner = isRecord(params.params) ? params.params : {}
    switch (method) {
      case 'ping':
        return { serverVersion: '0.0.1', protocol: 1 }
      case 'fs.home':
        return { path: 'D:\\code' }
      case 'fs.list':
        return {
          path: str(inner.path, 'D:\\code'),
          entries: [
            { name: 'qingcode-next', kind: 'dir' },
            { name: 'notes', kind: 'dir' },
            { name: 'README.md', kind: 'file' },
          ],
        }
      case 'codex.open':
        return { initialize: { userAgent: 'mock' }, lastSeq: this.seq, codexVersion: '0.172.0' }
      case 'codex.attach':
        return { lastSeq: this.seq, truncated: false }
      case 'codex.status':
        return { running: true, pid: 4242, activeTurns: 0 }
      default:
        throw new MockError('gateway', '该 server.req 方法不在手机网关白名单内')
    }
  }

  private codexSend(params: JsonRecord): void {
    const targetId = str(params.targetId, 'local')
    const msg = params.msg
    if (!isRecord(msg) || typeof msg.method !== 'string') return
    const id = msg.id
    const inner = isRecord(msg.params) ? msg.params : {}
    const threadId = str(inner.threadId, 't-demo')
    const nowSec = Math.floor(Date.now() / SECOND)

    switch (msg.method) {
      case 'thread/list':
        this.recv(targetId, { id, result: { data: this.threads } })
        return
      case 'thread/start': {
        const created = {
          id: `t-${++this.counter}`,
          cwd: str(inner.cwd),
          name: '',
          preview: '',
          updatedAt: nowSec,
          turns: [],
          status: { type: 'idle' },
        }
        this.threads.unshift(created)
        const thread = { ...created, ephemeral: inner.ephemeral === true }
        this.recv(targetId, { id, result: { thread } })
        this.recv(targetId, { method: 'thread/started', params: { thread } })
        return
      }
      case 'thread/resume':
      case 'thread/read':
        this.recv(targetId, {
          id,
          result: {
            thread: {
              id: threadId,
              cwd: '',
              name: '',
              preview: '',
              updatedAt: nowSec,
              status: { type: 'idle' },
              turns: [
                {
                  id: `turn-history-${threadId}`,
                  status: 'completed',
                  items: [
                    { type: 'userMessage', id: `u-${threadId}`, content: [{ type: 'text', text: '你好' }] },
                    { type: 'agentMessage', id: `a-${threadId}`, text: '你好！这是模拟的历史消息。' },
                  ],
                },
              ],
            },
          },
        })
        return
      case 'turn/start':
        this.simulateTurn(targetId, threadId, id, inner)
        return
      case 'turn/interrupt':
        this.recv(targetId, { id, result: {} })
        this.recv(targetId, {
          method: 'turn/completed',
          params: { threadId, turn: { id: 'turn-mock', status: 'interrupted' } },
        })
        return
      case 'account/rateLimits/read':
        this.recv(targetId, {
          id,
          result: {
            rateLimitsByLimitId: {
              codex: {
                limitId: 'codex',
                primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: nowSec + 5400 },
                secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: nowSec + 86_400 },
                credits: { hasCredits: false, unlimited: false, balance: '0' },
              },
            },
          },
        })
        return
      case 'account/read':
        this.recv(targetId, {
          id,
          result: { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus', workspaceName: '' } },
        })
        return
      default:
        this.recv(targetId, { id, error: { code: -32601, message: 'Method not found' } })
    }
  }

  private simulateTurn(targetId: string, threadId: string, id: unknown, params: JsonRecord): void {
    const turnId = `turn-${++this.counter}`
    const itemId = `item-${this.counter}`
    const input = Array.isArray(params.input) ? params.input : []
    const userText = input
      .map((entry) => (isRecord(entry) ? str(entry.text) : ''))
      .filter(Boolean)
      .join('\n')
    const answer = `收到：${userText || '（空消息）'}\n\n这是模拟的 **Markdown** 回复，用来验证流式消息与折叠展示。`
    const chunks = answer.match(/[\s\S]{1,12}/g) ?? [answer]
    const nowSec = Math.floor(Date.now() / SECOND)

    this.recv(targetId, { id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
    this.recv(targetId, {
      method: 'turn/started',
      params: {
        threadId,
        turnId,
        turn: {
          id: turnId,
          status: 'inProgress',
          items: [{ type: 'userMessage', id: `u-${turnId}`, content: [{ type: 'text', text: userText }] }],
        },
      },
    })
    this.recv(targetId, {
      method: 'item/started',
      params: {
        threadId,
        turnId,
        itemId,
        item: { type: 'agentMessage', id: itemId, text: '', status: 'inProgress' },
      },
    })
    let delay = 60
    for (const chunk of chunks) {
      setTimeout(
        () => this.recv(targetId, { method: 'item/agentMessage/delta', params: { threadId, itemId, delta: chunk } }),
        delay,
      )
      delay += 35
    }
    setTimeout(() => {
      this.recv(targetId, {
        method: 'item/completed',
        params: {
          threadId,
          itemId,
          item: { type: 'agentMessage', id: itemId, text: answer, status: 'completed' },
        },
      })
      this.recv(targetId, {
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'completed',
            items: [
              { type: 'userMessage', id: `u-${turnId}`, content: [{ type: 'text', text: userText }] },
              { type: 'agentMessage', id: itemId, text: answer, status: 'completed' },
            ],
          },
        },
      })
      this.recv(targetId, {
        method: 'thread/tokenUsage/updated',
        params: { threadId, tokenUsage: { total: 128 } },
      })
      this.recv(targetId, {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: nowSec + 5400 },
            secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: nowSec + 86_400 },
          },
        },
      })
    }, delay + 40)
  }

  private scheduleTargetStates(targetId: string): void {
    const id = targetId || 'local'
    this.emit({ name: 'target.state', payload: { id, state: 'connecting' } })
    setTimeout(() => this.emit({ name: 'target.state', payload: { id, state: 'deploying' } }), 120)
    setTimeout(() => this.emit({ name: 'target.state', payload: { id, state: 'ready' } }), 260)
  }

  private recv(targetId: string, msg: unknown): void {
    this.emit({ name: 'codex.recv', payload: { targetId, seq: ++this.seq, msg, agent: 'codex' } })
  }

  private emit(event: GatewayEvent): void {
    for (const stream of this.streams.values()) {
      this.hub.deliver(JSON.stringify({ stream: stream.id, event }))
    }
  }

  private closeStream(id: string, error: string | null): void {
    const stream = this.streams.get(id)
    if (!stream) return
    if (stream.heartbeat) clearInterval(stream.heartbeat)
    this.streams.delete(id)
    this.hub.deliver(JSON.stringify({ stream: id, closed: true, error }))
  }

  private reply(id: number, result: unknown): void {
    this.hub.deliver(JSON.stringify({ id, ok: true, result }))
  }

  private replyError(id: number, code: string, message: string): void {
    this.hub.deliver(JSON.stringify({ id, ok: false, error: message, code }))
  }

  private storageKey(key: string): string {
    return `${STORAGE_PREFIX}${key}`
  }

  private readStorage(key: string): string | null {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(this.storageKey(key))
    }
    return this.memory.get(key) ?? null
  }

  private writeStorage(key: string, value: string | null): void {
    if (typeof localStorage !== 'undefined') {
      if (value === null) localStorage.removeItem(this.storageKey(key))
      else localStorage.setItem(this.storageKey(key), value)
      return
    }
    if (value === null) this.memory.delete(key)
    else this.memory.set(key, value)
  }
}

export function createMockPort(hub: NativeCallbacks): NativePort {
  return new MockNativePort(hub)
}
