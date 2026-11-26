import type { AgentKind } from '../shared/backendApi'
import { join } from 'node:path'
import type { DirectTarget, SshTarget, Target, TargetProbe, TargetState } from '../shared/backendApi'
import { loadTargetSecret, saveTargetSecret } from './credentials'
import { HostKeyGate, type HostKeyDecider } from './hostKeyGate'
import { connectDirectTarget } from './directTarget'
import { connectLocalTarget } from './localTarget'
import { redactToken } from './remoteCommands'
import { RouterError } from './router'
import { ServerClientError } from './serverClient'
import { connectSshTarget, runRemoteServerCommands, testSshTarget } from './sshTarget'
import type {
  BackendEmit,
  DirectLinkContext,
  LinkFactory,
  LinkHooks,
  LocalLinkContext,
  SshLinkContext,
  SshRemoteContext,
  SshTestContext,
  TargetCredentials,
  TargetLink,
} from './types'

function agentOf(params: unknown): AgentKind {
  const value = isRecord(params) ? params.agent : undefined
  return value === 'claude' ? 'claude' : value === 'pi' ? 'pi' : 'codex'
}

export interface TargetManagerOptions {
  userData: string
  resourcesPath: string
  electronPath: string
  appVersion: string
  emit: BackendEmit
  autoAcceptHostKey?: boolean
  loadSecret?: (id: string, userData?: string) => Promise<TargetCredentials | null>
  saveSecret?: (id: string, credentials: TargetCredentials, userData?: string) => Promise<void>
  createSsh?: LinkFactory<SshLinkContext>
  createLocal?: LinkFactory<LocalLinkContext>
  createDirect?: LinkFactory<DirectLinkContext>
  testSsh?: (context: SshTestContext) => Promise<TargetProbe>
  runRemote?: (context: SshRemoteContext, commands: ReadonlyArray<readonly string[]>) => Promise<Array<Record<string, unknown>>>
  gate?: HostKeyDecider
}

// SSH 目标开了直连加速时，直连只给较短的时间；不通就回退 SSH，避免每次重连都卡满默认超时。
const DIRECT_FALLBACK_TIMEOUT_MS = 5_000
const STARTUP_CONNECT_TIMEOUT_MS = 60_000

/** SSH 目标上的直连配置换算成直连目标形状，复用 connectDirectTarget。 */
export function directViewOf(target: SshTarget): DirectTarget | null {
  if (!target.direct) return null
  return {
    id: target.id,
    kind: 'direct',
    name: target.name,
    host: target.direct.host,
    port: target.direct.port,
    fingerprint: target.direct.fingerprint,
  }
}

interface ReadyWaiter {
  resolve(): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Session {
  id: string
  target: Target
  desired: boolean
  state: TargetState
  link: TargetLink | null
  generation: number
  attempt: number
  retryTimer: ReturnType<typeof setTimeout> | null
  startupController: AbortController | null
  credentials: TargetCredentials
  remember: boolean
  /** 渲染进程 open/attach 过的 agent；重连后逐个补 attach。 */
  codexOpened: Set<AgentKind>
  everReady: boolean
  lastSeq: Record<AgentKind, number>
  lastError: string
  readyWaiters: ReadyWaiter[]
}

function requireToken(token: string | undefined): string {
  if (!token) throw new Error('缺少直连令牌，请重新粘贴连接码')
  return token
}

/** 断线重连退避：1s → 2s → 4s → … → 30s 封顶。 */
export function retryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt, 5))
  return Math.min(1000 * 2 ** exponent, 30_000)
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

function describe(err: unknown): string {
  return redactToken(err instanceof Error ? err.message : String(err))
}

/** id → TargetConnection：统一连接、重连、透传与事件加 targetId。 */
export class TargetManager {
  private readonly sessions = new Map<string, Session>()
  private readonly gate: HostKeyDecider
  private readonly createSsh: LinkFactory<SshLinkContext>
  private readonly createLocal: LinkFactory<LocalLinkContext>
  private readonly createDirect: LinkFactory<DirectLinkContext>
  private readonly testSsh: (context: SshTestContext) => Promise<TargetProbe>
  private readonly runRemote: NonNullable<TargetManagerOptions['runRemote']>
  private readonly loadSecret: (id: string, userData?: string) => Promise<TargetCredentials | null>
  private readonly saveSecret: (id: string, credentials: TargetCredentials, userData?: string) => Promise<void>

  constructor(private readonly options: TargetManagerOptions) {
    this.gate = options.gate ?? new HostKeyGate({
      userData: options.userData,
      emit: (prompt) => options.emit('hostKey.prompt', prompt),
      ...(options.autoAcceptHostKey !== undefined ? { autoAcceptNew: options.autoAcceptHostKey } : {}),
    })
    this.createSsh = options.createSsh ?? connectSshTarget
    this.createLocal = options.createLocal ?? connectLocalTarget
    this.createDirect = options.createDirect ?? connectDirectTarget
    this.testSsh = options.testSsh ?? testSshTarget
    this.runRemote = options.runRemote ?? runRemoteServerCommands
    this.loadSecret = options.loadSecret ?? loadTargetSecret
    this.saveSecret = options.saveSecret ?? saveTargetSecret
  }

  getState(id: string): TargetState {
    return this.sessions.get(id)?.state ?? 'idle'
  }

  async connect(target: Target, credentials: TargetCredentials, remember = false, startup = false): Promise<void> {
    let session = this.sessions.get(target.id)
    if (session?.desired && session.state === 'ready') {
      this.setState(session, 'ready', session.link?.notice)
      return
    }
    if (!session) {
      session = {
        id: target.id,
        target,
        desired: false,
        state: 'idle',
        link: null,
        generation: 0,
        attempt: 0,
        retryTimer: null,
        startupController: null,
        credentials: {},
        remember: false,
        codexOpened: new Set(),
        everReady: false,
        lastSeq: { codex: 0, claude: 0, pi: 0 },
        lastError: '',
        readyWaiters: [],
      }
      this.sessions.set(target.id, session)
    }
    session.target = target
    session.desired = true
    session.remember = remember
    session.attempt = 0
    this.clearRetry(session)
    const generation = ++session.generation
    session.startupController?.abort()
    const previousLink = session.link
    session.link = null
    previousLink?.close()
    const controller = startup ? new AbortController() : null
    session.startupController = controller
    const signal = controller?.signal
    const current = session

    const loadAndOpen = async (): Promise<void> => {
      const saved = target.kind === 'local' ? null : await this.readSecret(target.id, this.options.userData)
      if (generation !== current.generation || signal?.aborted) return
      current.credentials = { ...saved, ...credentials }
      await this.open(current, generation, signal)
    }
    if (!controller) return loadAndOpen()

    let stop!: () => void
    const stopped = new Promise<void>((resolve) => { stop = resolve })
    controller.signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => {
      controller.abort()
      if (generation !== current.generation) return
      const link = current.link
      current.link = null
      link?.close()
      this.handleFailure(current, new Error('启动时连接或更新远端 Server 超时，请手动重试'), false)
    }, STARTUP_CONNECT_TIMEOUT_MS)
    try {
      this.setState(current, 'connecting', '正在后台连接…')
      await Promise.race([loadAndOpen(), stopped])
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', stop)
      if (current.startupController === controller) current.startupController = null
    }
  }

  /** 试连一次，不影响现有会话；凭据合并规则与 connect 一致。 */
  async test(target: SshTarget, credentials: TargetCredentials): Promise<TargetProbe> {
    const saved = target.id ? await this.readSecret(target.id, this.options.userData) : null
    return this.testSsh({ target, credentials: { ...(saved ?? {}), ...credentials }, gate: this.gate })
  }

  /** 经 SSH 执行 server 子命令；凭据合并规则与 connect 一致，结果可能含 token，调用方不得记录。 */
  async remoteServer(
    target: SshTarget,
    credentials: TargetCredentials,
    commands: ReadonlyArray<readonly string[]>
  ): Promise<Array<Record<string, unknown>>> {
    const saved = await this.readSecret(target.id, this.options.userData)
    return this.runRemote({
      target,
      credentials: { ...(saved ?? {}), ...credentials },
      gate: this.gate,
      resourcesPath: this.options.resourcesPath,
    }, commands)
  }

  /** 更新直连 token（undefined 为清除），保留其它已保存凭据。 */
  async setDirectToken(id: string, token: string | undefined): Promise<void> {
    const saved = (await this.readSecret(id, this.options.userData)) ?? {}
    const { directToken: _old, ...rest } = saved
    await this.saveSecret(id, token ? { ...rest, directToken: token } : rest, this.options.userData)
    const session = this.sessions.get(id)
    if (session) {
      const { directToken: _stale, ...creds } = session.credentials
      session.credentials = token ? { ...creds, directToken: token } : creds
    }
  }

  /** 目标配置变更（如开启/关闭直连）后同步给现有会话，下次重连生效。 */
  updateTarget(target: Target): void {
    const session = this.sessions.get(target.id)
    if (session) session.target = target
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.desired = false
    session.remember = false
    session.everReady = false
    this.clearRetry(session)
    session.generation++
    session.startupController?.abort()
    session.startupController = null
    const link = session.link
    session.link = null
    link?.close()
    this.rejectWaiters(session, new Error(`目标 ${id} 已断开`))
    this.setState(session, 'idle')
  }

  async request(id: string, method: string, params?: unknown): Promise<unknown> {
    const session = this.sessions.get(id)
    if (!session?.link) throw new RouterError('not_connected', `目标 ${id} 未连接`)
    // 只有渲染进程用过 codex 的目标，重连后才需要自动补一次 attach。
    if (method === 'codex.open' || method === 'codex.attach') session.codexOpened.add(agentOf(params))
    try {
      return await session.link.request(method, params)
    } catch (err) {
      if (err instanceof ServerClientError) throw new RouterError(err.code, err.message)
      throw err
    }
  }

  codexSend(id: string, msg: unknown, agent: AgentKind = 'codex'): void {
    if (!isRecord(msg)) throw new RouterError('invalid_params', 'codex.send 需要 JSON-RPC 对象')
    const session = this.sessions.get(id)
    if (!session?.link) throw new RouterError('not_connected', `目标 ${id} 未连接`)
    try {
      session.link.codexSend(msg, agent)
    } catch (err) {
      if (err instanceof ServerClientError) throw new RouterError(err.code, err.message)
      throw err
    }
  }

  respondHostKey(promptId: string, accept: boolean): void {
    this.gate.respond(promptId, accept)
  }

  waitUntilReady(id: string, timeoutMs = 30_000): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return Promise.reject(new Error(`目标 ${id} 不存在`))
    if (session.state === 'ready') return Promise.resolve()
    // 首次连接失败且不会再重试时立刻失败，避免集成脚本空等超时。
    if (session.state === 'error' && !session.retryTimer) {
      return Promise.reject(new Error(session.lastError || `目标 ${id} 连接失败`))
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.readyWaiters = session.readyWaiters.filter((w) => w.timer !== timer)
        reject(new Error(`等待目标 ${id} 就绪超时（${session.state}）`))
      }, timeoutMs)
      session.readyWaiters.push({ resolve, reject, timer })
    })
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
    this.gate.close()
  }

  private async readSecret(id: string, userData?: string): Promise<TargetCredentials | null> {
    try {
      return await this.loadSecret(id, userData)
    } catch {
      return null
    }
  }

  private async open(session: Session, generation: number, signal?: AbortSignal): Promise<void> {
    const isCurrent = () => generation === session.generation && session.desired && !signal?.aborted
    let opened = false
    const hooks: LinkHooks = {
      onState: (state, detail) => {
        if (isCurrent()) this.setState(session, state, detail)
      },
      onEvent: (name, payload) => {
        if (isCurrent()) {
          this.options.emit('server.evt', { targetId: session.id, name, payload })
        }
      },
      onCodexRecv: (seq, msg, agent) => {
        if (!isCurrent()) return
        if (typeof seq === 'number' && seq > session.lastSeq[agent]) session.lastSeq[agent] = seq
        this.options.emit('codex.recv', { targetId: session.id, agent, seq, msg })
      },
      onClose: (err) => {
        if (!isCurrent() || !opened) return
        opened = false
        session.link = null
        const reconnect = session.everReady && (session.state === 'ready' || !signal)
        const detail = err ? describe(err) : '连接已断开'
        session.lastError = detail
        this.setState(session, 'error', detail)
        // 只有建立过的连接才自动重连；首次连接被拒绝（含拒绝指纹）不反复弹窗。
        if (reconnect) this.scheduleRetry(session)
        else this.rejectWaiters(session, new Error(detail))
      },
    }

    try {
      const link = session.target.kind === 'direct'
        ? await this.createDirect({
            target: session.target,
            token: requireToken(session.credentials.token),
            hooks,
            appVersion: this.options.appVersion,
            signal,
          })
        : session.target.kind === 'local'
        ? await this.createLocal({
            hooks,
            electronPath: this.options.electronPath,
            serverScript: join(this.options.resourcesPath, 'server', 'qn-server.cjs'),
            appVersion: this.options.appVersion,
          })
        : await this.openSsh(session, hooks, signal)

      if (!isCurrent()) {
        link.close()
        return
      }
      opened = true
      session.link = link
      // server 只向调用过 attach 的客户端广播 codex.recv，重连必须按 agent 各补一次。
      for (const agent of session.codexOpened) {
        try {
          await link.request('codex.attach', agent === 'codex'
            ? { sinceSeq: session.lastSeq.codex }
            : { agent, sinceSeq: session.lastSeq[agent] })
        } catch {
          // attach 失败不阻断连接，渲染进程可再发一次。
        }
      }
      if (!isCurrent() || !opened) {
        link.close()
        return
      }
      session.everReady = true
      session.attempt = 0
      this.setState(session, 'ready', link.notice)
      this.resolveWaiters(session)
      if (session.remember && Object.keys(session.credentials).length > 0) {
        session.remember = false
        // 等保存完成再返回，target.connect 回包后渲染进程刷新列表即可看到"已保存"。
        await this.saveSecret(session.id, session.credentials, this.options.userData).catch(() => undefined)
      }
    } catch (err) {
      if (!isCurrent() || session.retryTimer) return
      this.handleFailure(session, err, !signal)
    }
  }

  private async openSsh(session: Session, hooks: LinkHooks, signal?: AbortSignal): Promise<TargetLink> {
    const target = session.target as SshTarget
    const view = directViewOf(target)
    const token = session.credentials.directToken
    const ssh = () => this.createSsh({
      target,
      credentials: session.credentials,
      hooks,
      userData: this.options.userData,
      resourcesPath: this.options.resourcesPath,
      appVersion: this.options.appVersion,
      gate: signal ? { verify: (host, port, fingerprint) => this.gate.verify(host, port, fingerprint, false) } : this.gate,
      signal,
    })
    if (view && token) {
      const direct = () => this.createDirect({
        target: view,
        token,
        hooks,
        appVersion: this.options.appVersion,
        connectTimeoutMs: DIRECT_FALLBACK_TIMEOUT_MS,
        signal,
      })
      // 只有 SSH 能部署 Server，启动恢复时优先走 SSH；更新遇阻时仍可使用已有直连。
      if (signal) {
        try {
          return await ssh()
        } catch (err) {
          signal.throwIfAborted()
          const link = await direct()
          link.notice = `SSH 更新未完成（${describe(err)}），已通过直连连接`
          return link
        }
      }
      try {
        return await direct()
      } catch (err) {
        hooks.onState('connecting', `直连不可用（${describe(err)}），改用 SSH`)
      }
    }
    return ssh()
  }

  private handleFailure(session: Session, err: unknown, retry: boolean): void {
    if (!session.desired) return
    const detail = describe(err)
    session.lastError = detail
    this.setState(session, 'error', detail)
    if (retry && session.everReady) this.scheduleRetry(session)
    else this.rejectWaiters(session, new Error(detail))
  }

  private scheduleRetry(session: Session): void {
    if (!session.desired || !session.everReady || session.retryTimer) return
    const delay = retryDelay(session.attempt++)
    const timer = setTimeout(() => {
      session.retryTimer = null
      if (!session.desired) return
      this.setState(session, 'connecting', `重新连接（第 ${session.attempt} 次）`)
      void this.open(session, ++session.generation)
    }, delay)
    timer.unref?.()
    session.retryTimer = timer
  }

  private clearRetry(session: Session): void {
    if (session.retryTimer) clearTimeout(session.retryTimer)
    session.retryTimer = null
  }

  private setState(session: Session, state: TargetState, detail?: string): void {
    session.state = state
    if (state === 'ready') session.lastError = ''
    this.options.emit('target.state', {
      id: session.id,
      state,
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  private resolveWaiters(session: Session): void {
    for (const waiter of session.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    session.readyWaiters = []
  }

  private rejectWaiters(session: Session, err: Error): void {
    for (const waiter of session.readyWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    session.readyWaiters = []
  }
}
