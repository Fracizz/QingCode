import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyJsonRpc, FrameError, MAX_FRAME_BYTES, type JsonRpcId, type ServerMessage } from '@qn/protocol'
import { IdMapper } from './idMapper'
import { redact } from './log'
import { PendingRequests } from './pendingRequests'
import { ReplayBuffer } from './replayBuffer'
import { ThreadUsage } from './threadUsage'
import { TurnTiming } from './turnTiming'
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
  codexHome?: unknown
  claudeConfigDir?: unknown
}

export interface AgentHost {
  readonly lastSeq: number
  readonly activeTurns: number
  /** 轮次外仍在运行的后台任务数；不支持后台任务的 agent 省略。 */
  readonly backgroundTasks?: number
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

export function parseAgentConfigDir(value: unknown, name: string, platform = process.platform): string | undefined {
  if (value === undefined) return undefined
  const directory = typeof value === 'string' ? value.trim() : ''
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!paths.isAbsolute(directory) || directory.includes('\0') || (platform === 'win32' && paths.parse(directory).root.length < 2)) {
    throw new AgentHostError('params', `${name} 需要目标主机上的绝对路径`)
  }
  return directory
}

export function agentConfigEnv<T extends string | undefined>(
  env: Record<string, T>,
  variable: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR',
  directory: string | undefined,
  platform = process.platform,
): Record<string, T | string> {
  const next = { ...env } as Record<string, T | string>
  if (directory === undefined) return next
  if (platform === 'win32') {
    // Windows 环境变量名不区分大小写，避免旧值与覆盖项同时传给子进程。
    for (const name of Object.keys(next)) if (name.toUpperCase() === variable) delete next[name]
  }
  next[variable] = directory
  return next
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

type AccessSettings = { approvalPolicy: unknown; approvalsReviewer?: string; sandboxPolicy: Record<string, unknown> }
type StartingTurn = { threadId: unknown; completed: Set<string> }

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
const MAX_STDERR_CHARS = 1024 * 1024
const MAX_REPLAY_EVENT_BYTES = MAX_FRAME_BYTES - 128
const OVERSIZE_RESPONSE = {
  code: -32000,
  message: '会话数据超过传输大小上限',
  data: 'response_too_large',
}

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
  private readonly turnTiming = new TurnTiming()
  private readonly threadUsage: ThreadUsage

  constructor(
    protected readonly hub: AgentHostHub,
    protected readonly version: string = VERSION,
    protected readonly agentLabel: string = 'codex app-server',
    protected readonly eventName: string = 'codex',
    /** 给出时会话用量落盘，daemon 重启后打开历史会话仍有读数。 */
    usageStateDir?: string,
  ) {
    this.threadUsage = new ThreadUsage({ stateDir: usageStateDir, agent: eventName, log: (message) => hub.log(message) })
  }

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
      this.hub.log('忽略客户端发送的非法 JSON-RPC') // i18n-ignore: 仅进日志
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
          msg: { id: originalId, error: { code: -32000, message: `${this.agentLabel} 未运行` } }, // i18n-ignore: 按实际取值在词典登记整句
        })
        return
      }
      const threadId = msg.method === 'thread/turns/list' && isRecord(msg.params) ? msg.params.threadId : undefined
      const daemonId = this.ids.allocate(clientId, originalId, typeof threadId === 'string' ? threadId : undefined)
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
    this.turnTiming.clear()
    this.threadUsage.clear()
    this.closeAgent()
  }

  /** 子类把 agent→client 的原始 JSON-RPC 交给这里统一分配 seq、回放与广播。 */
  protected emit(msg: Record<string, unknown>): void {
    if (this.closed) return
    const kind = classifyJsonRpc(msg)
    if (kind === 'invalid') {
      this.hub.log('agent 发来无法识别的 JSON-RPC') // i18n-ignore: 仅进日志
      return
    }
    if (kind === 'response') {
      const forwarded = this.ids.take(msg.id)
      if (!forwarded) return
      const result = this.threadUsage.history(this.turnTiming.history(msg.result, forwarded.historyThreadId))
      const response = result === msg.result ? msg : { ...msg, result }
      try {
        this.hub.send(forwarded.clientId, {
          t: 'codex.recv',
          seq: null,
          msg: { ...response, id: forwarded.originalId },
        })
      } catch (err) {
        if (!(err instanceof FrameError) || err.code !== 'oversize') throw err
        this.hub.send(forwarded.clientId, {
          t: 'codex.recv',
          seq: null,
          msg: { id: forwarded.originalId, error: OVERSIZE_RESPONSE },
        })
      }
      return
    }

    if (kind === 'notification') {
      msg = this.turnTiming.notification(msg)
      this.threadUsage.notification(msg)
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
    this.turnTiming.clearRunning()
    for (const forwarded of this.ids.clear()) {
      this.hub.send(forwarded.clientId, {
        t: 'codex.recv',
        seq: null,
        msg: {
          id: forwarded.originalId,
          error: { code: -32000, message: `${this.agentLabel} 已退出` }, // i18n-ignore: 按实际取值在词典登记整句
        },
      })
    }
    // 所有 agent 统一用 codex.exited（mvp 约定的事件名），靠 agent 字段区分；
    // 客户端据此只处理对应 agent 的会话，不会因 codex 启动失败误伤正在用的 pi/Claude。
    this.hub.broadcastEvt('codex.exited', {
      agent: this.eventName,
      code: info.code ?? null,
      signal: info.signal ?? null,
      ...(info.message ? { message: redact(info.message) } : {}),
    })
    this.hub.log(
      // i18n-ignore: 仅进日志
      `${this.agentLabel} 退出 (code=${String(info.code)} signal=${String(info.signal)})`,
    )
  }

  protected clearReplay(): void {
    this.buffer.clear()
    this.turnTiming.clear()
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
  private skippingStdoutLine = false
  private stderrRemainder = ''
  private init: InitDeferred | null = null
  private initDone = false
  private initializeResult: unknown = null
  private initCounter = 0
  private readonly loadingThreads = new Set<string>()
  private readonly startingTurns = new Map<string, StartingTurn>()
  private readonly acknowledgedTurns = new Set<string>()
  private readonly threadAccess = new Map<string, AccessSettings>()
  private readonly managedAccess = new Set<string>()
  private codexHome: string | undefined
  private openQueue: Promise<unknown> = Promise.resolve()
  private replacingChild = false
  private shuttingDown = false

  constructor(hub: AgentHostHub, version: string = VERSION, options: { stateDir?: string } = {}) {
    super(hub, version, 'codex app-server', 'codex', options.stateDir)
  }

  protected openAgent(options: AgentOpenOptions): Promise<AgentRuntimeOpen> {
    const open = this.openQueue.then(async () => {
      const directory = parseAgentConfigDir(options.codexHome, 'CODEX_HOME')
      if (this.initCounter > 0 && this.codexHome !== directory) {
        if (this.child) {
          if (this.activeTurns > 0 || this.startingTurns.size > 0 || this.acknowledgedTurns.size > 0) {
            throw new AgentHostError('config_dir_busy', 'Codex 正在运行，请在当前轮次结束后再切换配置目录')
          }
          await this.replaceChild(this.child)
        }
        this.clearReplay()
      }
      if (this.shuttingDown) throw new Error('server 正在退出')
      if (!this.child) this.start(options.codexPath, directory)
      const init = this.init
      if (!init) throw new Error('codex 初始化状态异常')
      try {
        await init.promise
      } catch (err) {
        if (this.child && !this.shuttingDown) await this.replaceChild(this.child)
        throw err
      }
      return { initialize: this.initializeResult ?? null }
    })
    this.openQueue = open.catch(() => {})
    return open
  }

  protected agentStatus(): RuntimeStatus {
    const child = this.child
    if (child && !this.replacingChild && typeof child.pid === 'number') return { running: true, pid: child.pid }
    return { running: false }
  }

  protected sendToAgent(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.hub.log('codex stdin 不可写，消息已丢弃') // i18n-ignore: 仅进日志
      return
    }
    try {
      const outgoing = this.prepareRequest(msg)
      if (!outgoing) return
      const line = JSON.stringify(outgoing)
      if (typeof line === 'string') stdin.write(`${line}\n`)
    } catch {
      this.hub.log('序列化发往 codex 的消息失败') // i18n-ignore: 仅进日志
    }
  }

  protected detachAgent(_clientId: number): void {}

  protected closeAgent(): void {
    this.shuttingDown = true
    const child = this.child
    this.child = null
    this.initDone = false
    this.init?.reject(new Error('server 正在退出'))
    this.init = null
    this.clearRequestState()
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

  private async replaceChild(child: ChildProcess): Promise<void> {
    this.replacingChild = true
    try {
      await new Promise<void>((resolve, reject) => {
        const onExit = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          child.removeListener('exit', onExit)
          reject(new AgentHostError('config_dir_busy', 'Codex 尚未退出，配置目录未切换，请稍后重试'))
        }, 3000)
        child.once('exit', onExit)
        child.kill()
      })
    } finally {
      this.replacingChild = false
    }
  }

  private start(codexPath: unknown, directory: string | undefined): void {
    const spec = resolveCodexCommand(codexPath)
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: spec.shell,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: agentConfigEnv(process.env, 'CODEX_HOME', directory),
    })
    this.child = child
    this.codexHome = directory
    this.stdoutRemainder = ''
    this.skippingStdoutLine = false
    this.stderrRemainder = ''
    this.initializeResult = null

    const initId = `qn-init-${++this.initCounter}`
    this.initDone = false
    this.init = makeDeferred(initId, INIT_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.child === child) this.onStdout(chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      if (this.child === child) this.onStderr(toText(chunk))
    })
    child.stdin?.on('error', () => this.hub.log('codex stdin 写入失败')) // i18n-ignore: 仅进日志
    child.on('error', (err: Error) => {
      if (this.child !== child) return
      this.hub.log(`codex 启动失败: ${redact(err.message)}`) // i18n-ignore: 仅进日志
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
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start)
      const end = newline < 0 ? chunk.length : newline
      if (!this.skippingStdoutLine) {
        // 历史回包可接近协议帧上限，必须按整行计数，且跳过超长行的后续片段。
        if (this.stdoutRemainder.length + end - start > MAX_FRAME_BYTES) {
          const head = this.stdoutRemainder.slice(0, 128) + chunk.slice(start, Math.min(end, start + 128))
          const responseId = /^\s*\{\s*"id"\s*:\s*"(qn-c\d+)"\s*,\s*"(?:result|error)"\s*:/.exec(head)?.[1]
          this.stdoutRemainder = ''
          this.skippingStdoutLine = true
          // app-server 的响应把 id 放在内容之前，超限时仍可结束这条请求。
          if (responseId) this.handleCodexMessage({ id: responseId, error: OVERSIZE_RESPONSE })
          else this.hub.log('codex stdout 单行过长，已丢弃') // i18n-ignore: 仅进日志
        } else {
          this.stdoutRemainder += chunk.slice(start, end)
        }
      }
      if (newline < 0) return
      const line = this.stdoutRemainder.trim()
      this.stdoutRemainder = ''
      this.skippingStdoutLine = false
      if (line) this.consumeLine(line)
      start = end + 1
    }
  }

  private onStderr(chunk: string): void {
    this.stderrRemainder += chunk
    if (this.stderrRemainder.length > MAX_STDERR_CHARS) {
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

  private consumeLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.hub.log('codex stdout 出现非 JSON 行') // i18n-ignore: 仅进日志
      return
    }
    if (!isRecord(parsed)) {
      this.hub.log('codex stdout 出现非对象消息') // i18n-ignore: 仅进日志
      return
    }
    // 回放还会附加帧类型和序号，须在入缓冲前为这些字段留出空间。
    if (line.length > MAX_REPLAY_EVENT_BYTES / 3
        && classifyJsonRpc(parsed) !== 'response' && Buffer.byteLength(JSON.stringify(parsed)) > MAX_REPLAY_EVENT_BYTES) {
      this.hub.log('codex stdout 事件超过传输大小上限') // i18n-ignore: 仅进日志
      return
    }
    this.handleCodexMessage(parsed)
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
    if (typeof msg.id === 'string' && ('result' in msg || 'error' in msg)) {
      const pending = this.startingTurns.get(msg.id)
      if (pending) {
        this.startingTurns.delete(msg.id)
        const turn = isRecord(msg.result) && isRecord(msg.result.turn) ? msg.result.turn : null
        // RPC 响应可能先于 turn/started 通知抵达，配置目录切换也要保护这段间隔。
        if (turn?.status === 'inProgress' && typeof turn.id === 'string' && !pending.completed.has(turn.id)) {
          this.acknowledgedTurns.add(turn.id)
        }
      }
      if (this.loadingThreads.delete(msg.id)) this.readThreadAccess(msg.result)
    }
    if (msg.method === 'turn/completed' && isRecord(msg.params) && isRecord(msg.params.turn)) {
      const id = msg.params.turn.id
      const threadId = msg.params.threadId
      if (typeof id === 'string') {
        this.acknowledgedTurns.delete(id)
        for (const pending of this.startingTurns.values()) {
          if (pending.threadId === threadId) pending.completed.add(id)
        }
      }
    }
    this.emit(msg)
  }

  private prepareRequest(msg: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof msg.id !== 'string') return msg
    if (msg.method === 'thread/start' || msg.method === 'thread/resume' || msg.method === 'thread/fork') {
      this.loadingThreads.add(msg.id)
    }
    if (msg.method !== 'turn/start' || !isRecord(msg.params)) return msg
    const { qingcodeAccessOverride, ...params } = msg.params
    const threadId = params.threadId
    if (typeof threadId === 'string') {
      const baseline = this.threadAccess.get(threadId)
      if (qingcodeAccessOverride === true) {
        if (!baseline) {
          this.emit({ id: msg.id, error: { code: -32602, message: '无法确认会话默认权限，请重新打开会话后重试' } })
          return null
        }
        this.managedAccess.add(threadId)
      } else if (baseline && this.managedAccess.has(threadId)) {
        // app-server 将每轮覆盖项沿用到后续轮次，普通发送需要恢复会话原有权限。
        params.approvalPolicy ??= baseline.approvalPolicy
        params.sandboxPolicy ??= baseline.sandboxPolicy
        // 「替我批准」会切换审批审查方，也需随基线一起恢复。
        if (baseline.approvalsReviewer) params.approvalsReviewer ??= baseline.approvalsReviewer
      }
    }
    this.startingTurns.set(msg.id, { threadId, completed: new Set() })
    return { ...msg, params }
  }

  private readThreadAccess(result: unknown): void {
    if (!isRecord(result) || !isRecord(result.thread) || !isRecord(result.sandbox)) return
    const id = result.thread.id
    const { approvalPolicy, approvalsReviewer, sandbox } = result
    if (typeof id !== 'string' || this.managedAccess.has(id)) return
    if (typeof approvalPolicy !== 'string' && !isRecord(approvalPolicy)) return
    this.threadAccess.set(id, {
      approvalPolicy,
      sandboxPolicy: sandbox,
      ...(typeof approvalsReviewer === 'string' ? { approvalsReviewer } : {}),
    })
  }

  private clearRequestState(): void {
    this.loadingThreads.clear()
    this.startingTurns.clear()
    this.acknowledgedTurns.clear()
    this.threadAccess.clear()
    this.managedAccess.clear()
  }

  private finishChild(
    code: number | null,
    signal: NodeJS.Signals | null,
    errorMessage: string | null,
  ): void {
    this.child = null
    this.initDone = false
    this.init?.reject(new Error(describeCodexExit(code, errorMessage)))
    this.init = null
    this.clearRequestState()
    this.emitExit({
      code,
      signal,
      ...(errorMessage ? { message: redact(errorMessage) } : {}),
    })
  }
}

/** 启动失败要说清原因：笼统的"已退出"让用户无从排查（如目标机根本没装 codex）。 */
export function describeCodexExit(code: number | null, errorMessage: string | null): string {
  if (errorMessage && /\bENOENT\b/.test(errorMessage)) {
    return '未找到 codex 命令：请先安装 Codex CLI（npm i -g @openai/codex），或在设置中指定 codex 路径'
  }
  if (errorMessage) return `codex 启动失败: ${redact(errorMessage)}`
  return code === null ? 'codex app-server 已退出' : `codex app-server 已退出（退出码 ${String(code)}）`
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
