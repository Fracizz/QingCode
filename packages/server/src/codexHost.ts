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

export interface CodexCommand {
  command: string
  args: string[]
  shell: boolean
  /** Windows .cmd/.bat 经 cmd.exe 启动时需要原样传参 */
  windowsVerbatimArguments?: boolean
}

export interface CodexResolveEnv {
  platform: string
  pathValue: string
  delimiter: string
  home: string
  appData?: string
  localAppData?: string
  comspec?: string
}

export function defaultCodexResolveEnv(): CodexResolveEnv {
  return {
    platform: process.platform,
    pathValue: process.env['PATH'] ?? '',
    delimiter: path.delimiter,
    home: os.homedir(),
    ...(process.env['APPDATA'] ? { appData: process.env['APPDATA'] } : {}),
    ...(process.env['LOCALAPPDATA'] ? { localAppData: process.env['LOCALAPPDATA'] } : {}),
    ...(process.env['ComSpec'] ? { comspec: process.env['ComSpec'] } : {}),
  }
}

// 引号会破坏 cmd /s 的边界，% / ! 会在 cmd 里展开，换行能注入新命令；这些字符一律拒绝。
const CMD_UNSAFE = /["%!\r\n\0]/

/** 每个 token 单独加引号；cmd /s 剥离最外层引号后，& | < > 等元字符仍在引号内。 */
export function quoteCmdToken(value: string): string {
  if (CMD_UNSAFE.test(value)) throw new Error('Windows 脚本参数包含不允许的字符')
  return `"${value}"`
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
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
    // spawn 找不到可执行文件时明确报"未安装"，客户端据此把 Codex 置灰并改用其它 Agent，而不是反复重试。
    const missing = errorMessage !== null && /ENOENT/.test(errorMessage)
    this.init?.reject(
      missing
        ? new AgentHostError('agent_unavailable', '未找到 codex（未安装或不在 PATH 中，可在设置里指定路径）')
        : new Error('codex app-server 已退出'),
    )
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
 * 解析顺序：参数 → PATH → 常见安装位置。Windows 额外补 npm 全局（codex.cmd）、
 * WindowsApps（codex.exe）与官方安装器目录；只做存在性检查，不下载/安装（合规 §7）。
 */
export function codexCandidates(
  explicit?: string,
  env: CodexResolveEnv = defaultCodexResolveEnv(),
): string[] {
  if (explicit) return [explicit]
  const win = env.platform === 'win32'
  const p = win ? path.win32 : path.posix
  const names = win ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']
  const dirs = env.pathValue.split(env.delimiter).filter(Boolean)
  const extras = win
    ? [
        ...(env.appData ? [p.join(env.appData, 'npm')] : []),
        ...(env.localAppData
          ? [p.join(env.localAppData, 'Microsoft', 'WindowsApps')]
          : []),
        ...(env.localAppData
          ? [p.join(env.localAppData, 'Programs', 'OpenAI', 'Codex', 'bin')]
          : []),
        p.join(env.home, '.local', 'bin'),
      ]
    : [
        p.join(env.home, '.local', 'bin'),
        '/usr/local/bin',
        p.join(env.home, '.npm-global', 'bin'),
      ]
  const result: string[] = []
  const seen = new Set<string>()
  for (const dir of [...dirs, ...extras]) {
    for (const name of names) {
      const candidate = p.join(dir, name)
      const key = win ? candidate.toLowerCase() : candidate
      if (seen.has(key)) continue
      seen.add(key)
      result.push(candidate)
    }
  }
  return result
}

/**
 * 测试钩子：codexPath 为 JSON 数组字符串时按 [可执行文件, ...参数] 原样启动，
 * 便于用假 codex 脚本跑端到端；其余情况按上面的候选顺序解析。
 */
export function resolveCodexCommand(
  codexPath?: unknown,
  env: CodexResolveEnv = defaultCodexResolveEnv(),
  exists: (file: string) => boolean = isExecutable,
): CodexCommand {
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
  for (const candidate of codexCandidates(explicit, env)) {
    if (!exists(candidate)) continue
    try {
      return wrapCommand(candidate, ['app-server'], env)
    } catch {
      // 路径含 cmd 不允许的字符时跳过，尝试下一个候选。
    }
  }
  // 找不到实体文件时交给 spawn 走 PATH（Windows 的 codex.cmd 也由 libuv 兜底）。
  return wrapCommand(explicit ?? 'codex', ['app-server'], env)
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * .cmd/.bat 只能经 cmd.exe 启动：不用 shell:true（Node 会把未转义参数直接拼接），
 * 改成 /d /v:off /s /c + 逐 token 加引号 + windowsVerbatimArguments 原样传参。
 */
export function wrapCommand(
  command: string,
  args: string[],
  env: CodexResolveEnv = defaultCodexResolveEnv(),
): CodexCommand {
  if (env.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const comspec =
      env.comspec && !CMD_UNSAFE.test(env.comspec) ? env.comspec : 'cmd.exe'
    const line = `"${[command, ...args].map(quoteCmdToken).join(' ')}"`
    return {
      command: comspec,
      args: ['/d', '/v:off', '/s', '/c', line],
      shell: false,
      windowsVerbatimArguments: true,
    }
  }
  return { command, args, shell: false }
}
