import type { AgentKind } from '../shared/backendApi'
import { join } from 'node:path'
import type { SshTarget, Target, TargetState } from '../shared/backendApi'
import { loadTargetSecret, saveTargetSecret } from './credentials'
import { HostKeyGate, type HostKeyDecider } from './hostKeyGate'
import { connectLocalTarget } from './localTarget'
import { redactToken } from './remoteCommands'
import { RouterError } from './router'
import { ServerClientError } from './serverClient'
import { connectSshTarget } from './sshTarget'
import type {
  BackendEmit,
  LinkFactory,
  LinkHooks,
  LocalLinkContext,
  SshLinkContext,
  TargetCredentials,
  TargetLink,
} from './types'

function agentOf(params: unknown): AgentKind {
  return isRecord(params) && params.agent === 'claude' ? 'claude' : 'codex'
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
  gate?: HostKeyDecider
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
  credentials: TargetCredentials
  remember: boolean
  /** 渲染进程 open/attach 过的 agent；重连后逐个补 attach。 */
  codexOpened: Set<AgentKind>
  everReady: boolean
  lastSeq: Record<AgentKind, number>
  lastError: string
  readyWaiters: ReadyWaiter[]
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
    this.loadSecret = options.loadSecret ?? loadTargetSecret
    this.saveSecret = options.saveSecret ?? saveTargetSecret
  }

  getState(id: string): TargetState {
    return this.sessions.get(id)?.state ?? 'idle'
  }

  async connect(target: Target, credentials: TargetCredentials, remember = false): Promise<void> {
    let session = this.sessions.get(target.id)
    if (session?.desired && session.state === 'ready') return
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
        credentials: {},
        remember: false,
        codexOpened: new Set(),
        everReady: false,
        lastSeq: { codex: 0, claude: 0 },
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

    let effective = credentials
    if (target.kind === 'ssh') {
      const saved = await this.readSecret(target.id, this.options.userData)
      effective = { ...(saved ?? {}), ...credentials }
    }
    session.credentials = effective

    // open 内部自行处理失败与重试，避免过期的一次连接失败覆盖后续重连结果。
    await this.open(session)
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.desired = false
    session.remember = false
    session.everReady = false
    this.clearRetry(session)
    session.generation++
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

  private async open(session: Session): Promise<void> {
    const generation = ++session.generation
    const hooks: LinkHooks = {
      onState: (state, detail) => {
        if (generation === session.generation) this.setState(session, state, detail)
      },
      onEvent: (name, payload) => {
        if (generation === session.generation) {
          this.options.emit('server.evt', { targetId: session.id, name, payload })
        }
      },
      onCodexRecv: (seq, msg, agent) => {
        if (generation !== session.generation) return
        if (typeof seq === 'number' && seq > session.lastSeq[agent]) session.lastSeq[agent] = seq
        this.options.emit('codex.recv', { targetId: session.id, agent, seq, msg })
      },
      onClose: (err) => {
        if (generation !== session.generation) return
        session.link = null
        if (!session.desired) {
          this.setState(session, 'idle')
          return
        }
        const detail = err ? describe(err) : '连接已断开'
        session.lastError = detail
        this.setState(session, 'error', detail)
        // 只有建立过的连接才自动重连；首次连接被拒绝（含拒绝指纹）不反复弹窗。
        if (session.everReady) this.scheduleRetry(session)
        else this.rejectWaiters(session, new Error(detail))
      },
    }

    try {
      const link = session.target.kind === 'local'
        ? await this.createLocal({
            hooks,
            electronPath: this.options.electronPath,
            serverScript: join(this.options.resourcesPath, 'server', 'qn-server.cjs'),
            appVersion: this.options.appVersion,
          })
        : await this.createSsh({
            target: session.target as SshTarget,
            credentials: session.credentials,
            hooks,
            userData: this.options.userData,
            resourcesPath: this.options.resourcesPath,
            appVersion: this.options.appVersion,
            gate: this.gate,
          })

      if (generation !== session.generation || !session.desired) {
        link.close()
        return
      }
      session.link = link
      session.everReady = true
      session.attempt = 0
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
      if (generation !== session.generation || !session.desired) {
        link.close()
        return
      }
      this.setState(session, 'ready')
      this.resolveWaiters(session)
      if (session.remember && Object.keys(session.credentials).length > 0) {
        session.remember = false
        void this.saveSecret(session.id, session.credentials, this.options.userData).catch(() => undefined)
      }
    } catch (err) {
      if (generation !== session.generation || !session.desired || session.retryTimer) return
      this.handleFailure(session, err)
    }
  }

  private handleFailure(session: Session, err: unknown): void {
    if (!session.desired) return
    const detail = describe(err)
    session.lastError = detail
    this.setState(session, 'error', detail)
    if (session.everReady) this.scheduleRetry(session)
    else this.rejectWaiters(session, new Error(detail))
  }

  private scheduleRetry(session: Session): void {
    if (!session.desired || !session.everReady || session.retryTimer) return
    const delay = retryDelay(session.attempt++)
    const timer = setTimeout(() => {
      session.retryTimer = null
      if (!session.desired) return
      this.setState(session, 'connecting', `重新连接（第 ${session.attempt} 次）`)
      void this.open(session)
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
