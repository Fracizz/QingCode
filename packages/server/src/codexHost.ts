import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyJsonRpc, type JsonRpcId, type ServerMessage } from '@qn/protocol'
import { IdMapper } from './idMapper'
import { redact } from './log'
import { PendingRequests } from './pendingRequests'
import { ReplayBuffer } from './replayBuffer'
import { VERSION } from './version'

export interface CodexHostHub {
  send(clientId: number, msg: ServerMessage): void
  broadcastRecv(seq: number, msg: Record<string, unknown>): void
  broadcastEvt(name: string, payload: Record<string, unknown>): void
  log(message: string): void
}

/** 通用 "JSON-RPC agent host" 的接口；Codex 与 Claude 各自持有一套实例与 seq。 */
export type AgentHostHub = CodexHostHub

export interface CodexOpenResult {
  initialize: unknown
  lastSeq: number
  codexVersion?: string
  agentVersion?: string
}

export interface AgentOpenOptions {
  codexPath?: unknown
  claudePath?: unknown
}

export interface AgentHost {
  readonly lastSeq: number
  readonly activeTurns: number
  open(options?: AgentOpenOptions): Promise<CodexOpenResult>
  attach(clientId: number, sinceSeq: number): { lastSeq: number; truncated: boolean }
  handleClientMessage(clientId: number, msg: unknown): void
  detach(clientId: number): void
  status(): { running: boolean; pid?: number; activeTurns: number }
  shutdown(): void
}

/** 带业务错误码的 agent 错误，daemon 按 code 回给客户端（如 agent_unavailable）。 */
export class AgentHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AgentHostError'
  }
}

export interface AgentExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  message?: string
}

interface AgentRuntimeOpen {
  initialize?: unknown
  agentVersion?: string
}

interface RuntimeStatus {
  running: boolean
  pid?: number
}

interface InitDeferred {
  id: string
  promise: Promise<void>
  resolve(): void
  reject(err: Error): void
}

interface CodexCommand {
  command: string
  args: string[]
  shell: boolean
}

const INIT_TIMEOUT_MS = 10_000
const MAX_LINE_BYTES = 1024 * 1024

/**
 * 一个 agent 独占一套 id 映射 / 回放缓冲 / 未决请求 / turn 计数。
 * 子进程或 SDK 的启动与通信由子类实现，客户端只见 JSON-RPC 业务消息。
 */
export abstract class JsonRpcAgentHost implements AgentHost {
  private turns = 0
  private closed = false
  private readonly ids = new IdMapper()
  private readonly buffer = new ReplayBuffer()
  private readonly pending = new PendingRequests()

  constructor(
    protected readonly hub: AgentHostHub,
    protected readonly version: string = VERSION,
    protected readonly agentLabel: string = 'codex app-server',
    protected readonly eventName: string = 'codex',
  ) {}

  get lastSeq(): number {
    return this.buffer.lastSeq
  }

  get activeTurns(): number {
    return this.turns
  }

  status(): { running: boolean; pid?: number; activeTurns: number } {
    return { ...this.agentStatus(), activeTurns: this.turns }
  }

  /** 懒启动 agent，等内部 initialize 完成后返回缓存的 InitializeResponse。 */
  async open(options: AgentOpenOptions = {}): Promise<CodexOpenResult> {
    if (this.closed) throw new Error('server 正在退出')
    const opened = await this.openAgent(options)
    const result: CodexOpenResult = {
      initialize: opened.initialize ?? null,
      lastSeq: this.buffer.lastSeq,
    }
    const version = opened.agentVersion ?? deriveAgentVersion(opened.initialize)
    return version ? { ...result, codexVersion: version, agentVersion: version } : result
  }

  /** 回放 sinceSeq 之后的消息，并补发仍未决的审批请求（可能被缓冲淘汰过）。 */
  attach(clientId: number, sinceSeq: number): { lastSeq: number; truncated: boolean } {
    const from = Number.isFinite(sinceSeq) ? Math.floor(sinceSeq) : 0
    const { messages, truncated } = this.buffer.since(from)
    const sent = new Set<number>()
    for (const entry of messages) {
      sent.add(entry.seq)
      this.hub.send(clientId, { t: 'codex.recv', seq: entry.seq, msg: entry.msg })
    }
    for (const request of this.pending.snapshot()) {
      if (sent.has(request.seq)) continue
      this.hub.send(clientId, { t: 'codex.recv', seq: request.seq, msg: request.msg })
    }
    return { lastSeq: this.buffer.lastSeq, truncated }
  }

  handleClientMessage(clientId: number, msg: unknown): void {
    if (!isRecord(msg)) return
    const kind = classifyJsonRpc(msg)
    if (kind === 'invalid') {
      this.hub.log('忽略客户端发送的非法 JSON-RPC')
      return
    }
    if (kind === 'request') {
      const originalId = msg.id as JsonRpcId
      if (msg.method === 'initialize') {
        // initialize 已由 daemon 完成，重复握手会破坏 agent 状态。
        this.hub.send(clientId, {
          t: 'codex.recv',
          seq: null,
          msg: { id: originalId, error: { code: -32600, message: 'initialize 由 daemon 处理' } },
        })
        return
      }
      if (!this.agentStatus().running) {
        this.hub.send(clientId, {
          t: 'codex.recv',
          seq: null,
          msg: { id: originalId, error: { code: -32000, message: `${this.agentLabel} 未运行` } },
        })
        return
      }
      const daemonId = this.ids.allocate(clientId, originalId)
      this.sendToAgent({ ...msg, id: daemonId })
      return
    }
    if (kind === 'notification') {
      if (msg.method === 'initialized') return
      this.sendToAgent(msg)
      return
    }
    // 客户端对 server→client 请求的响应：第一个生效，其余忽略。
    const id = msg.id as JsonRpcId
    if (!this.pending.resolve(id)) return
    this.sendToAgent(msg)
  }

  detach(clientId: number): void {
    this.ids.dropClient(clientId)
    this.detachAgent(clientId)
  }

  shutdown(): void {
    this.closed = true
    this.turns = 0
    this.pending.clear()
    this.ids.clear()
    this.closeAgent()
  }

  /** 子类把 agent→client 的原始 JSON-RPC 交给这里统一分配 seq、回放与广播。 */
  protected emit(msg: Record<string, unknown>): void {
    if (this.closed) return
    const kind = classifyJsonRpc(msg)
    if (kind === 'invalid') {
      this.hub.log('agent 发来无法识别的 JSON-RPC')
      return
    }
    if (kind === 'response') {
      const forwarded = this.ids.take(msg.id)
      if (!forwarded) return
      this.hub.send(forwarded.clientId, {
        t: 'codex.recv',
        seq: null,
        msg: { ...msg, id: forwarded.originalId },
      })
      return
    }

    const seq = this.buffer.push(msg).seq
    if (kind === 'request') {
      this.pending.add(msg.id as JsonRpcId, msg, seq)
    }
    this.trackTurn(msg)
    if (
      kind === 'notification' &&
      msg.method === 'serverRequest/resolved' &&
      isRecord(msg.params)
    ) {
      const resolvedId = msg.params.requestId ?? msg.params.id
      if (typeof resolvedId === 'string' || typeof resolvedId === 'number') {
        this.pending.drop(resolvedId)
      }
    }
    this.hub.broadcastRecv(seq, msg)
  }

  /** 进程/SDK 退出：未完成请求全部报错，并广播退出事件。 */
  protected emitExit(info: AgentExitInfo): void {
    this.turns = 0
    this.pending.clear()
    for (const forwarded of this.ids.clear()) {
      this.hub.send(forwarded.clientId, {
        t: 'codex.recv',
        seq: null,
        msg: {
          id: forwarded.originalId,
          error: { code: -32000, message: `${this.agentLabel} 已退出` },
        },
      })
    }
    this.hub.broadcastEvt(`${this.eventName}.exited`, {
      code: info.code ?? null,
      signal: info.signal ?? null,
      ...(info.message ? { message: redact(info.message) } : {}),
    })
    this.hub.log(
      `${this.agentLabel} 退出 (code=${String(info.code)} signal=${String(info.signal)})`,
    )
  }

  private trackTurn(msg: Record<string, unknown>): void {
    if (msg.method === 'turn/started') this.turns += 1
    else if (msg.method === 'turn/completed' || msg.method === 'turn/aborted') {
      this.turns = Math.max(0, this.turns - 1)
    }
  }

  protected abstract openAgent(options: AgentOpenOptions): Promise<AgentRuntimeOpen>
  protected abstract agentStatus(): RuntimeStatus
  protected abstract sendToAgent(msg: Record<string, unknown>): void
  protected abstract detachAgent(clientId: number): void
  protected abstract closeAgent(): void
}

/**
 * 一个 daemon 只有一个 codex app-server 子进程；initialize / initialized 由 daemon 自己做，
 * 客户端只见 JSON-RPC 业务消息。
 */
export class CodexHost extends JsonRpcAgentHost {
  private child: ChildProcess | null = null
  private stdoutRemainder = ''
  private stderrRemainder = ''
  private init: InitDeferred | null = null
  private initDone = false
  private initializeResult: unknown = null
  private initCounter = 0

  constructor(hub: AgentHostHub, version: string = VERSION) {
    super(hub, version, 'codex app-server', 'codex')
  }

  protected async openAgent(options: AgentOpenOptions): Promise<AgentRuntimeOpen> {
    if (!this.child) this.start(options.codexPath)
    const init = this.init
    if (!init) throw new Error('codex 初始化状态异常')
    await init.promise
    return { initialize: this.initializeResult ?? null }
  }

  protected agentStatus(): RuntimeStatus {
    const child = this.child
    if (child && typeof child.pid === 'number') return { running: true, pid: child.pid }
    return { running: false }
  }

  protected sendToAgent(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.hub.log('codex stdin 不可写，消息已丢弃')
      return
    }
    try {
      const line = JSON.stringify(msg)
      if (typeof line === 'string') stdin.write(`${line}\n`)
    } catch {
      this.hub.log('序列化发往 codex 的消息失败')
    }
  }

  protected detachAgent(_clientId: number): void {}

  protected closeAgent(): void {
    const child = this.child
    this.child = null
    this.initDone = false
    this.init?.reject(new Error('server 正在退出'))
    this.init = null
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      // 进程可能已退出。
    }
    try {
      child.kill()
    } catch {
      // 同上。
    }
  }

  private start(codexPath?: unknown): void {
    const spec = resolveCodexCommand(codexPath)
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: spec.shell,
      env: { ...process.env },
    })
    this.child = child
    this.stdoutRemainder = ''
    this.stderrRemainder = ''
    this.initializeResult = null

    const initId = `qn-init-${++this.initCounter}`
    this.initDone = false
    this.init = makeDeferred(initId, INIT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: unknown) => this.onStdout(toText(chunk)))
    child.stderr?.on('data', (chunk: unknown) => this.onStderr(toText(chunk)))
    child.stdin?.on('error', () => this.hub.log('codex stdin 写入失败'))
    child.on('error', (err: Error) => {
      if (this.child !== child) return
      this.hub.log(`codex 启动失败: ${redact(err.message)}`)
      this.finishChild(null, null, err.message)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) return
      this.finishChild(code, signal, null)
    })

    this.sendToAgent({
      id: initId,
      method: 'initialize',
      params: { clientInfo: { name: 'qingcode-next', version: this.version } },
    })
  }

  private onStdout(chunk: string): void {
    this.stdoutRemainder += chunk
    if (this.stdoutRemainder.length > MAX_LINE_BYTES) {
      this.stdoutRemainder = ''
      this.hub.log('codex stdout 单行过长，已丢弃')
      return
    }
    this.consumeLines()
  }

  private onStderr(chunk: string): void {
    this.stderrRemainder += chunk
    if (this.stderrRemainder.length > MAX_LINE_BYTES) {
      this.hub.log(`codex stderr: ${redact(this.stderrRemainder)}`)
      this.stderrRemainder = ''
      return
    }
    let index: number
    while ((index = this.stderrRemainder.indexOf('\n')) >= 0) {
      const line = this.stderrRemainder.slice(0, index).trim()
      this.stderrRemainder = this.stderrRemainder.slice(index + 1)
      if (line) this.hub.log(`codex stderr: ${redact(line)}`)
    }
  }

  private consumeLines(): void {
    let index: number
    while ((index = this.stdoutRemainder.indexOf('\n')) >= 0) {
      const line = this.stdoutRemainder.slice(0, index).trim()
      this.stdoutRemainder = this.stdoutRemainder.slice(index + 1)
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.hub.log('codex stdout 出现非 JSON 行')
        continue
      }
      if (isRecord(parsed)) this.handleCodexMessage(parsed)
      else this.hub.log('codex stdout 出现非对象消息')
    }
  }

  private handleCodexMessage(msg: Record<string, unknown>): void {
    // initialize 的响应属于 daemon 自己的握手，不能转发给客户端。
    // 成功后的 deferred 要保留：后续 codex.open 直接复用已完成的握手结果。
    if (this.init && !this.initDone && msg.id === this.init.id && ('result' in msg || 'error' in msg)) {
      const init = this.init
      if (msg.error !== undefined) {
        this.init = null
        init.reject(new Error('codex initialize 失败'))
        return
      }
      this.initDone = true
      this.initializeResult = msg.result ?? null
      this.sendToAgent({ method: 'initialized' })
      init.resolve()
      return
    }
    this.emit(msg)
  }

  private finishChild(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage: string | null,
  ): void {
    this.child = null
    this.initDone = false
    this.init?.reject(new Error('codex app-server 已退出'))
    this.init = null
    this.emitExit({
      code,
      signal,
      ...(errorMessage ? { message: redact(errorMessage) } : {}),
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toText(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

function makeDeferred(id: string, timeoutMs: number): InitDeferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  // 避免 initialize 超时在 open 之外形成未处理的 rejection。
  void promise.catch(() => {})
  const timer = setTimeout(() => reject(new Error('codex initialize 超时')), timeoutMs)
  return {
    id,
    promise,
    resolve: () => {
      clearTimeout(timer)
      resolve()
    },
    reject: (err: Error) => {
      clearTimeout(timer)
      reject(err)
    },
  }
}

function deriveAgentVersion(initialize: unknown): string | undefined {
  if (!isRecord(initialize) || typeof initialize.userAgent !== 'string') return undefined
  return initialize.userAgent.match(/\d+\.\d+\.\d+/)?.[0]
}

/**
 * 测试钩子：codexPath 为 JSON 数组字符串时按 [可执行文件, ...参数] 原样启动，
 * 便于用假 codex 脚本跑端到端；正常路径解析顺序为参数 → PATH → 常见安装位置。
 */
function resolveCodexCommand(codexPath?: unknown): CodexCommand {
  if (typeof codexPath === 'string' && codexPath.trim().startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(codexPath)
    } catch {
      throw new Error('codexPath 数组不是合法 JSON')
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      typeof parsed[0] !== 'string' ||
      parsed[0].length === 0 ||
      !parsed.every((item) => typeof item === 'string')
    ) {
      throw new Error('codexPath 数组必须是 [可执行文件, ...参数]')
    }
    return { command: parsed[0], args: parsed.slice(1) as string[], shell: false }
  }

  const explicit = typeof codexPath === 'string' && codexPath.trim() ? codexPath.trim() : undefined
  const candidates = explicit ? [explicit] : codexCandidates()
  for (const candidate of candidates) {
    if (!isExecutable(candidate)) continue
    return wrapCommand(candidate, ['app-server'])
  }
  // 找不到实体文件时交给 spawn 走 PATH（Windows 的 codex.cmd 也由 libuv 兜底）。
  return wrapCommand(explicit ?? 'codex', ['app-server'])
}

function codexCandidates(): string[] {
  const isWindows = process.platform === 'win32'
  const names = isWindows ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  if (isWindows) {
    const result: string[] = []
    for (const dir of dirs) for (const name of names) result.push(path.join(dir, name))
    return result
  }
  const home = os.homedir()
  return [
    ...dirs.map((dir) => path.join(dir, 'codex')),
    path.join(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    path.join(home, '.npm-global', 'bin', 'codex'),
  ]
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function wrapCommand(command: string, args: string[]): CodexCommand {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // cmd.exe 才能启动 .cmd；加引号让含空格的路径可用，并去掉引号避免注入。
    return { command: `"${command.replace(/"/g, '')}"`, args, shell: true }
  }
  return { command, args, shell: false }
}
