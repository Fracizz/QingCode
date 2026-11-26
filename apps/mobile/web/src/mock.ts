// 浏览器开发模式：无 window.QnNative 时用内存假数据把全部页面点通（多 Agent、只读文件/差异；不触网、不打印凭据）。
import type { TermInfo, TermOutputChunk } from '@qn/protocol'
import { buildConnectionInfo, normalizeFingerprint } from './link'
import type { NativeCallbacks, NativePort } from './native'
import type { AgentKind, GatewayEvent, Project, Target } from './types'

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
type MockTerminal = { project: Project; info: TermInfo; chunks: TermOutputChunk[]; attached: boolean }

/** 本机启用 Codex / Claude / pi（pi 模拟未安装），93 上关闭 Claude。 */
export const MOCK_AGENT_SETTINGS = {
  defaultAgent: 'codex',
  agents: {
    local: { codex: { enabled: true }, claude: { enabled: true }, pi: { enabled: true } },
    'ssh-93': { claude: { enabled: false }, pi: { enabled: false } },
  },
}

const effort = (reasoningEffort: string, description = '') => ({ reasoningEffort, description })

const MOCK_MODELS: Record<AgentKind, JsonRecord[]> = {
  codex: [
    {
      id: 'gpt-5.5-codex',
      model: 'gpt-5.5-codex',
      displayName: 'GPT-5.5 Codex',
      description: 'Our most capable model for complex coding and professional work.',
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [effort('low'), effort('medium'), effort('high'), effort('xhigh')],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
    },
    {
      id: 'gpt-5.5-mini',
      model: 'gpt-5.5-mini',
      displayName: 'GPT-5.5 Mini',
      description: 'Fast, go-to model for coding and everyday work.',
      isDefault: false,
      hidden: false,
      supportedReasoningEfforts: [effort('minimal'), effort('low'), effort('medium')],
      defaultReasoningEffort: 'low',
      serviceTiers: [],
    },
  ],
  claude: [
    {
      id: 'claude-default',
      model: 'default',
      displayName: '默认（跟随 Claude 设置）',
      description: '',
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [effort('low'), effort('medium'), effort('high'), effort('max')],
      defaultReasoningEffort: 'high',
      serviceTiers: [],
    },
    {
      id: 'claude-fast',
      model: 'haiku',
      displayName: 'Haiku',
      description: 'Lightweight and cheap.',
      isDefault: false,
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: '',
      serviceTiers: [],
    },
  ],
  pi: [],
}

const agentOf = (value: unknown): AgentKind => (value === 'claude' || value === 'pi' ? value : 'codex')
const agentName = (agent: AgentKind): string => (agent === 'claude' ? 'Claude' : agent === 'pi' ? 'pi' : 'Codex')

/** 1×1 透明 PNG。 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
/** 每次最多返回 8 KiB，便于在浏览器里看到"已截断 / 加载更多"。 */
const MOCK_READ_CAP = 8 * 1024

function mockText(path: string): string {
  const lines = [`// mock file: ${path}`]
  for (let index = 2; index <= 800; index += 1) lines.push(`line ${index}: const value${index} = ${index * 7}`)
  return `${lines.join('\n')}\n`
}

function mockRead(path: string, params: JsonRecord): JsonRecord {
  if (!path) throw new MockError('params', '缺少 path')
  if (/missing/i.test(path)) throw new MockError('not_found', '文件不存在')
  const mtimeMs = Date.now()
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
    return { path, content: TINY_PNG, encoding: 'base64', size: 68, mtimeMs, offset: 0, length: 68, truncated: false, binary: true }
  }
  if (/\.(bin|exe|zip)$/i.test(path)) {
    return { path, content: '', encoding: 'utf8', size: 4096, mtimeMs, offset: 0, length: 0, truncated: false, binary: true }
  }
  const text = mockText(path)
  const offset = typeof params.offset === 'number' && params.offset > 0 ? Math.floor(params.offset) : 0
  const requested = typeof params.length === 'number' && params.length > 0 ? Math.floor(params.length) : 2 * 1024 * 1024
  const length = Math.max(0, Math.min(requested, MOCK_READ_CAP, text.length - offset))
  return {
    path,
    content: text.slice(offset, offset + length),
    encoding: 'utf8',
    size: text.length,
    mtimeMs,
    offset,
    length,
    truncated: offset + length < text.length,
    binary: false,
  }
}

function mockDiff(path: string): string {
  const name = path.replace(/\\/g, '/')
  return [
    `diff --git a/${name} b/${name}`,
    'index 1111111..2222222 100644',
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -10,6 +10,7 @@ export function demo() {',
    '   const a = 1',
    '-  const b = 2',
    '+  const b = 3',
    '+  const c = a + b',
    '   return a',
    ' }',
    '',
  ].join('\n')
}

const MOCK_PROJECT_PATHS = [
  'README.md', '.gitignore', 'docs', 'docs/mvp.md',
  'apps', 'apps/mobile', 'apps/mobile/web', 'apps/mobile/web/src', 'apps/mobile/web/src/store.ts',
]
const MOCK_PROJECT_FILE_MTIME = Date.now()
const mockBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))

function mockProjectFiles(method: string, params: JsonRecord): JsonRecord {
  const path = str(params.path)
  const paths = MOCK_PROJECT_PATHS.filter((entry) =>
    method === 'mobile.files.read' || params.hidden === true || !entry.startsWith('.'),
  )
  const entries = paths.map((entry) => {
    const directory = MOCK_PROJECT_PATHS.some((candidate) => candidate.startsWith(`${entry}/`))
    return {
      path: entry, name: basename(entry), kind: directory ? 'dir' : 'file',
      mtimeMs: MOCK_PROJECT_FILE_MTIME,
      size: directory ? 0 : new TextEncoder().encode(mockText(entry)).length,
    }
  })
  const directory = path ? `${path}/` : ''
  if (method === 'mobile.files.read') {
    const file = entries.find((entry) => entry.path === path && entry.kind === 'file')
    if (!file) throw new MockError('not_found', '文件不存在')
    const data = new TextEncoder().encode(mockText(path))
    const offset = Number.isSafeInteger(params.offset) ? Math.max(0, Number(params.offset)) : 0
    const length = Number.isSafeInteger(params.length) ? Math.max(0, Number(params.length)) : 262_144
    const part = data.slice(offset, offset + Math.min(length, 262_144))
    const version = `${MOCK_PROJECT_FILE_MTIME}:${data.length}`
    if (params.version !== undefined && params.version !== version) throw new MockError('conflict', '文件已修改')
    const content = mockBase64(part)
    return { content, length: part.length, size: data.length, version }
  }
  if (method === 'mobile.files.list') {
    if (path && !entries.some((entry) => entry.path === path && entry.kind === 'dir')) {
      throw new MockError('not_found', '目录不存在')
    }
    return {
      entries: entries.filter((entry) => entry.path.startsWith(directory) && !entry.path.slice(directory.length).includes('/')),
      truncated: false,
    }
  }
  const query = str(params.query).toLocaleLowerCase()
  const limit = typeof params.limit === 'number' ? Math.max(0, Math.min(params.limit, 200)) : 200
  const matches = entries.filter((entry) =>
    entry.path.startsWith(directory) && entry.path.toLocaleLowerCase().includes(query) && entry.kind === 'file',
  )
  return { entries: matches.slice(0, limit), truncated: matches.length > limit }
}

export class MockNativePort implements NativePort {
  private readonly streams = new Map<string, Stream>()
  private readonly memory = new Map<string, string>()
  private readonly projects: Project[] = [...MOCK_PROJECTS]
  private readonly terminals = new Map<string, MockTerminal>()
  private readonly threads = new Map<AgentKind, JsonRecord[]>([
    [
      'codex',
      [
        {
          id: 't-demo',
          preview: '帮我看看这个项目',
          name: '示例会话',
          cwd: 'D:\\code\\qingcode-next',
          updatedAt: Math.floor(Date.now() / SECOND),
        },
      ],
    ],
    [
      'claude',
      [
        {
          id: 'c-demo',
          preview: '用 Claude 审查一下改动',
          name: 'Claude 示例会话',
          cwd: 'D:\\code\\qingcode-next',
          updatedAt: Math.floor(Date.now() / SECOND) - 60,
        },
      ],
    ],
  ])
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
    if (method.startsWith('mobile.term.')) return this.mockTerminal(method, params)
    switch (method) {
      case 'targets.list':
        return MOCK_TARGETS
      case 'target.connect':
        this.scheduleTargetStates(str(params.id))
        return null
      case 'target.disconnect':
        this.emit({ name: 'target.state', payload: { id: str(params.id), state: 'idle' } })
        return null
      case 'mobile.agents':
        return MOCK_AGENT_SETTINGS
      case 'mobile.files.list':
      case 'mobile.files.search':
      case 'mobile.files.read': {
        const project = this.projects.find((item) => item.id === params.projectId && item.targetId === params.targetId)
        if (!project) throw new MockError('not_found', '项目不存在')
        return mockProjectFiles(method, params)
      }
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
        this.codexSend(params, agentOf(params.agent ?? request.agent))
        return null
      }
      default:
        throw new MockError('forbidden', '该方法不在手机网关白名单内')
    }
  }

  private mockTerminal(method: string, params: JsonRecord): unknown {
    const project = this.projects.find((item) => item.id === params.projectId && item.targetId === params.targetId)
    if (!project) throw new MockError('not_found', '项目不存在')
    if (method === 'mobile.term.list') {
      return { terminals: [...this.terminals.values()].filter((item) => item.project.id === project.id).map((item) => item.info) }
    }
    if (method === 'mobile.term.open') {
      const termId = `mock-terminal-${++this.counter}`
      const info: TermInfo = {
        termId, cwd: project.path, shell: '模拟终端', args: [], pid: null, backend: 'python',
        supportsResize: true, alive: true, lastSeq: 0, cols: Number(params.cols) || 80,
        rows: Number(params.rows) || 24, startedAt: Date.now(),
      }
      const terminal: MockTerminal = { project, info, attached: false, chunks: [] }
      this.terminals.set(termId, terminal)
      this.mockTerminalOutput(terminal, '模拟终端 · 文本仅回显\r\n> ')
      return { ...info, created: true }
    }
    const terminal = this.terminals.get(str(params.termId))
    if (!terminal || terminal.project.id !== project.id) throw new MockError('term_not_found', '终端不存在')
    const { info, chunks } = terminal
    switch (method) {
      case 'mobile.term.attach': {
        terminal.attached = true
        const since = Number(params.sinceSeq) || 0
        const truncated = since + 1 < (chunks[0]?.seq ?? 0)
        return { ...info, truncated, mode: truncated ? 'resync' : 'replay', chunks: chunks.filter((chunk) => chunk.seq > since) }
      }
      case 'mobile.term.detach':
        terminal.attached = false
        return {}
      case 'mobile.term.resize':
        info.cols = Number(params.cols) || info.cols
        info.rows = Number(params.rows) || info.rows
        return { cols: info.cols, rows: info.rows, applied: true }
      case 'mobile.term.write': {
        const bytes = Uint8Array.from(atob(str(params.data)), (byte) => byte.charCodeAt(0))
        const text = new TextDecoder().decode(bytes).replace(/\x03/g, '^C\r').replace(/\r\n?|\n/g, '\r\n> ')
        if (text) this.mockTerminalOutput(terminal, text)
        return { acceptedBytes: bytes.length }
      }
      case 'mobile.term.close':
        this.terminals.delete(info.termId)
        return {}
      default:
        throw new MockError('forbidden', '未知手机终端操作')
    }
  }

  private mockTerminalOutput(terminal: MockTerminal, text: string): void {
    const { project, info, chunks } = terminal
    const chunk = { seq: ++info.lastSeq, data: mockBase64(new TextEncoder().encode(text)) }
    chunks.push(chunk)
    if (chunks.length > 128) chunks.shift()
    if (terminal.attached) {
      this.emit({
        name: 'mobile.terminal',
        payload: { targetId: project.targetId, projectId: project.id, name: 'term.data', payload: { termId: info.termId, ...chunk } },
      })
    }
  }

  private serverReq(params: JsonRecord): unknown {
    const method = str(params.method)
    const inner = isRecord(params.params) ? params.params : {}
    const agent = agentOf(inner.agent ?? params.agent)
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
        // 模拟"目标机上没装 pi"：只影响 pi，不影响其他 Agent。
        if (agent === 'pi') throw new MockError('agent_unavailable', '未找到 pi（模拟）')
        return { initialize: { userAgent: `mock-${agent}` }, lastSeq: this.seq, agentVersion: '0.0.0-mock' }
      case 'codex.attach':
        return { lastSeq: this.seq, truncated: false }
      case 'codex.status':
        return { running: agent !== 'pi', pid: 4242, activeTurns: 0 }
      case 'fs.read':
        return mockRead(str(inner.path), inner)
      case 'git.status':
        return {
          root: 'D:\\code\\qingcode-next',
          branch: 'next',
          head: 'abc1234',
          ahead: 0,
          behind: 0,
          files: [{ path: 'apps/mobile/web/src/store.ts', index: '.', worktree: 'M', conflict: false }],
        }
      case 'git.diff': {
        const path = str(inner.path)
        if (!str(inner.cwd)) throw new MockError('params', '缺少 cwd')
        // 名字里带 clean 的文件模拟"已提交、无工作区差异"，用于验证回退到卡片 diff。
        if (/clean/i.test(path)) return { diff: '', truncated: false }
        return { diff: mockDiff(path), truncated: false }
      }
      default:
        throw new MockError('forbidden', '该 server.req 方法不在手机网关白名单内')
    }
  }

  private codexSend(params: JsonRecord, agent: AgentKind): void {
    const targetId = str(params.targetId, 'local')
    const msg = params.msg
    if (!isRecord(msg) || typeof msg.method !== 'string') return
    const id = msg.id
    const inner = isRecord(msg.params) ? msg.params : {}
    const threads = this.threadsFor(agent)
    const threadId = str(inner.threadId, threads[0] ? str(threads[0].id) : 't-demo')
    const nowSec = Math.floor(Date.now() / SECOND)
    const recv = (payload: unknown) => this.recv(targetId, agent, payload)

    switch (msg.method) {
      case 'thread/list': {
        const cwds = Array.isArray(inner.cwd) ? inner.cwd : typeof inner.cwd === 'string' ? [inner.cwd] : null
        const data = cwds ? threads.filter((thread) => cwds.includes(thread.cwd)) : threads
        recv({ id, result: { data } })
        return
      }
      case 'thread/start': {
        const created = {
          id: `${agent === 'codex' ? 't' : agent}-${++this.counter}`,
          cwd: str(inner.cwd),
          name: '',
          preview: '',
          updatedAt: nowSec,
          turns: [],
          status: { type: 'idle' },
        }
        threads.unshift(created)
        const thread = { ...created, ephemeral: inner.ephemeral === true }
        recv({ id, result: { thread } })
        recv({ method: 'thread/started', params: { thread } })
        return
      }
      case 'thread/resume':
      case 'thread/read':
        recv({
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
                    {
                      type: 'agentMessage',
                      id: `a-${threadId}`,
                      text: `你好！这是 ${agentName(agent)} 的模拟历史消息，可点击 [README.md](README.md:3) 或 \`apps/mobile/web/src/store.ts:42\` 查看文件。`,
                    },
                  ],
                },
              ],
            },
          },
        })
        return
      case 'turn/start':
        this.lastTurnParams = { agent, ...inner }
        this.simulateTurn(targetId, agent, threadId, id, inner)
        return
      case 'turn/interrupt':
        recv({ id, result: {} })
        recv({
          method: 'turn/completed',
          params: { threadId, turn: { id: 'turn-mock', status: 'interrupted' } },
        })
        return
      case 'model/list':
        if (agent === 'pi') {
          recv({ id, error: { code: -32601, message: 'Method not found' } })
          return
        }
        recv({ id, result: { data: MOCK_MODELS[agent], nextCursor: null } })
        return
      case 'account/rateLimits/read':
        recv({
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
        recv({
          id,
          result: { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus', workspaceName: '' } },
        })
        return
      default:
        recv({ id, error: { code: -32601, message: 'Method not found' } })
    }
  }

  /** 最近一次 turn/start 的参数（含 agent），供单测核对模型覆盖项。 */
  lastTurnParams: JsonRecord | null = null

  private threadsFor(agent: AgentKind): JsonRecord[] {
    let list = this.threads.get(agent)
    if (!list) {
      list = []
      this.threads.set(agent, list)
    }
    return list
  }

  private simulateTurn(targetId: string, agent: AgentKind, threadId: string, id: unknown, params: JsonRecord): void {
    const turnId = `turn-${++this.counter}`
    const itemId = `item-${this.counter}`
    const changeId = `change-${this.counter}`
    const input = Array.isArray(params.input) ? params.input : []
    const userText = input
      .map((entry) => (isRecord(entry) ? str(entry.text) : ''))
      .filter(Boolean)
      .join('\n')
    const answer = `收到：${userText || '（空消息）'}\n\n这是 ${agentName(agent)} 模拟的 **Markdown** 回复，改动见 [store.ts](apps/mobile/web/src/store.ts#L12)，也可以点 \`README.md:3\`。`
    const chunks = answer.match(/[\s\S]{1,12}/g) ?? [answer]
    const nowSec = Math.floor(Date.now() / SECOND)
    const change = {
      type: 'fileChange',
      id: changeId,
      status: 'completed',
      changes: [{ path: 'apps/mobile/web/src/store.ts', kind: { type: 'update' }, diff: mockDiff('apps/mobile/web/src/store.ts') }],
    }
    const recv = (payload: unknown) => this.recv(targetId, agent, payload)

    recv({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
    recv({
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
    recv({ method: 'item/completed', params: { threadId, turnId, itemId: changeId, item: change } })
    recv({
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
      setTimeout(() => recv({ method: 'item/agentMessage/delta', params: { threadId, itemId, delta: chunk } }), delay)
      delay += 35
    }
    setTimeout(() => {
      recv({
        method: 'item/completed',
        params: {
          threadId,
          itemId,
          item: { type: 'agentMessage', id: itemId, text: answer, status: 'completed' },
        },
      })
      recv({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'completed',
            items: [
              { type: 'userMessage', id: `u-${turnId}`, content: [{ type: 'text', text: userText }] },
              change,
              { type: 'agentMessage', id: itemId, text: answer, status: 'completed' },
            ],
          },
        },
      })
      recv({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId, turnId, tokenUsage: { total: { totalTokens: 128 }, ...(agent === 'claude' ? { estimatedCostUsd: 0.012 } : {}) },
        },
      })
      if (agent === 'codex') {
        recv({
          method: 'account/rateLimits/updated',
          params: {
            rateLimits: {
              primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: nowSec + 5400 },
              secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: nowSec + 86_400 },
            },
          },
        })
      } else if (agent === 'claude') {
        recv({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 81, windowDurationMins: 300, resetsAt: nowSec + 2700 } } },
        })
      }
    }, delay + 40)
  }

  private scheduleTargetStates(targetId: string): void {
    const id = targetId || 'local'
    this.emit({ name: 'target.state', payload: { id, state: 'connecting' } })
    setTimeout(() => this.emit({ name: 'target.state', payload: { id, state: 'deploying' } }), 120)
    setTimeout(() => this.emit({ name: 'target.state', payload: { id, state: 'ready' } }), 260)
  }

  private recv(targetId: string, agent: AgentKind, msg: unknown): void {
    const response = isRecord(msg) && !msg.method && ('result' in msg || 'error' in msg)
    this.emit({ name: 'codex.recv', payload: { targetId, seq: response ? null : ++this.seq, msg, agent } })
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
