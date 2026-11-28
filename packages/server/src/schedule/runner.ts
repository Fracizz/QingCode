import { classifyJsonRpc, type AgentKind, type JsonRpcId, type ScheduleRun, type ScheduleRuntime } from '@qn/protocol'
import type { TurnStartParams } from '../../../../vendor/codex-protocol/ts/v2/TurnStartParams'
import type { ThreadStartParams } from '../../../../vendor/codex-protocol/ts/v2/ThreadStartParams'
import { AgentHostError, parseAgentConfigDir, type AgentHost } from '../codexHost'

const CLIENT_ID = -1
const START_TIMEOUT = 60_000
const RUN_TIMEOUT = 60 * 60_000
const INTERRUPT_TIMEOUT = 15_000

type Json = Record<string, unknown>
type RunUpdate = Pick<ScheduleRun, 'status' | 'reason' | 'threadId'>
export type ScheduledExecution = {
  taskId: string
  agent: AgentKind
  cwd: string
  prompt: string
  runtime: ScheduleRuntime
  update: (patch: RunUpdate, resetAt?: number | null) => boolean
}

type Active = ScheduledExecution & {
  threadId?: string
  turnId?: string
  stop?: 'timeout' | 'rateLimited' | 'interrupted'
  stopSent?: boolean
  uncertain?: boolean
  sending?: boolean
  resetAt?: number | null
  deadline?: ReturnType<typeof setTimeout>
  waiting: Set<JsonRpcId>
}

class RequestError extends Error {
  constructor(readonly data?: unknown, readonly timedOut = false) { super('Scheduled agent request failed') }
}

const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}

export function runtimeConfig(agent: AgentKind, options: ScheduleRuntime): string | undefined {
  if (agent === 'codex') return parseAgentConfigDir(options.codexHome, 'CODEX_HOME')
  if (agent === 'claude') return parseAgentConfigDir(options.claudeConfigDir, 'CLAUDE_CONFIG_DIR')
}

export function runtimePath(agent: AgentKind, options: ScheduleRuntime): string | undefined {
  return (agent === 'codex' ? options.codexPath : agent === 'claude' ? options.claudePath : options.piPath)?.trim() || undefined
}

export class ScheduleRunner {
  private active?: Active
  private nextId = 0
  private readonly requests = new Map<number, (error?: RequestError, result?: unknown) => void>()

  constructor(private readonly hosts: Record<AgentKind, AgentHost>) {}

  get busy(): boolean { return this.active !== undefined }
  get blocksUpgrade(): boolean { return !!this.active && !this.active.uncertain }

  matchesOpen(agent: AgentKind, options: ScheduleRuntime): boolean {
    const current = this.active
    if (!current || current.agent !== agent) return true
    return runtimeConfig(agent, current.runtime) === runtimeConfig(agent, options) &&
      runtimePath(agent, current.runtime) === runtimePath(agent, options)
  }

  start(options: ScheduledExecution): void {
    const active: Active = { ...options, waiting: new Set() }
    this.active = active
    void this.launch(active)
  }

  stop(taskIds?: ReadonlySet<string>): void {
    if (this.active && (!taskIds || taskIds.has(this.active.taskId))) this.requestStop(this.active, 'interrupted')
  }

  receiveResponse(agent: AgentKind, msg: unknown): void {
    const { id, error, result } = asRecord(msg)
    if (this.active?.agent === agent && typeof id === 'number') {
      this.requests.get(id)?.(error ? new RequestError(error) : undefined, result)
    }
  }

  receive(agent: AgentKind, msg: Json): void {
    const active = this.active
    if (!active || active.agent !== agent) return
    const params = asRecord(msg.params)
    if (msg.method === 'account/rateLimits/updated') {
      const snapshot = asRecord(params.rateLimits)
      if (snapshot.rateLimitReachedType || snapshot.spendControlReached === true) {
        active.resetAt = limitReset(snapshot)
        this.requestStop(active, 'rateLimited')
      }
      return
    }
    if (!active.threadId) return
    if (msg.method === 'serverRequest/resolved') {
      const id = (params.requestId ?? params.id) as JsonRpcId
      if (active.waiting.delete(id) && !active.waiting.size && !active.stop) {
        active.update({ status: 'running', threadId: active.threadId })
      }
      return
    }
    if (params.threadId !== active.threadId) return
    if (classifyJsonRpc(msg) === 'request') {
      active.waiting.add(msg.id as JsonRpcId)
      if (!active.stop) active.update({ status: 'waiting', threadId: active.threadId })
      return
    }
    const turn = asRecord(params.turn)
    if (typeof turn.id !== 'string' || (active.turnId && turn.id !== active.turnId)) return
    if (msg.method === 'turn/started') {
      active.turnId = turn.id
      if (active.stop) this.requestStop(active, active.stop)
    } else if (msg.method === 'turn/completed') {
      this.completeTurn(active, turn)
    }
  }

  exited(agent: unknown): void {
    if (this.active?.agent === agent && this.active) {
      this.finish(this.active, this.active.stop === 'rateLimited' ? 'rateLimited' : 'failed', 'agentExited')
    }
  }

  private async launch(active: Active): Promise<void> {
    const host = this.hosts[active.agent]
    try {
      await host.open({ ...active.runtime, requireSameConfiguration: true })
    } catch (error) {
      this.finish(active, 'failed', error instanceof AgentHostError && error.code === 'config_dir_busy'
        ? 'profileChanged' : 'agentUnavailable')
      return
    }
    if (this.active !== active) return
    try {
      const params: ThreadStartParams = {
        cwd: active.cwd, ephemeral: false,
        ...(active.agent === 'codex' ? { sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' } : {}),
      }
      const started = asRecord(await this.request(active, 'thread/start', params))
      const threadId = asRecord(started.thread).id
      if (typeof threadId !== 'string' || !threadId) throw new RequestError()
      if (this.active !== active) return
      active.threadId = threadId
      if (active.agent === 'codex' && (asRecord(started.sandbox).type !== 'readOnly' ||
        started.approvalPolicy !== 'on-request' || started.approvalsReviewer !== 'user')) {
        this.finish(active, 'failed', 'permissionsUnavailable')
        return
      }
      if (!active.update({ status: 'running', threadId })) {
        this.finish(active, 'failed', 'startFailed')
        return
      }
      const input = [{ type: 'text', text: active.prompt, text_elements: [] }] satisfies TurnStartParams['input']
      const codexAccess = {
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      } satisfies Partial<TurnStartParams>
      active.sending = true
      const result = asRecord(await this.request(active, 'turn/start', {
        threadId, input,
        ...(active.agent === 'codex' ? codexAccess : {}),
        ...(active.agent === 'claude' ? { claudePermissionMode: 'plan' } : {}),
      }))
      if (this.active !== active) return
      const turn = asRecord(result.turn)
      if (typeof turn.id !== 'string') {
        this.requestStop(active, 'timeout')
        return
      }
      active.turnId = turn.id
      if (turn.status !== 'inProgress') {
        this.completeTurn(active, turn)
      } else if (active.stop) {
        this.requestStop(active, active.stop)
      } else {
        active.deadline = setTimeout(() => this.requestStop(active, 'timeout'), RUN_TIMEOUT).unref()
      }
    } catch (error) {
      if (this.active !== active) return
      if (error instanceof RequestError && active.sending && (error.timedOut || active.turnId)) {
        this.requestStop(active, isRateLimited(error.data) ? 'rateLimited' : 'timeout')
      } else {
        this.finish(active, error instanceof RequestError && isRateLimited(error.data) ? 'rateLimited' : 'failed',
          error instanceof RequestError && error.timedOut ? 'timeout' : 'startFailed')
      }
    }
  }

  private request(active: Active, method: string, params: Json): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const receive = (error?: RequestError, result?: unknown): void => {
        clearTimeout(timer)
        this.requests.delete(id)
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => receive(new RequestError(undefined, true)), START_TIMEOUT).unref()
      this.requests.set(id, receive)
      try {
        this.hosts[active.agent].handleClientMessage(CLIENT_ID, { id, method, params })
      } catch {
        receive(new RequestError())
      }
    })
  }

  private requestStop(active: Active, reason: NonNullable<Active['stop']>): void {
    if (this.active !== active) return
    active.stop ??= reason
    if (!active.sending) {
      this.finish(active, reason === 'rateLimited' ? 'rateLimited' : 'interrupted')
      return
    }
    if (active.stopSent) return
    clearTimeout(active.deadline)
    active.deadline = setTimeout(() => {
      active.uncertain = true
      active.update({ status: active.stop === 'rateLimited' ? 'rateLimited' : 'interrupted',
        threadId: active.threadId, reason: 'timeout' }, active.resetAt)
    }, INTERRUPT_TIMEOUT).unref()
    if (active.turnId) {
      active.stopSent = true
      void this.request(active, 'turn/interrupt', { threadId: active.threadId, turnId: active.turnId }).catch(() => undefined)
    }
  }

  private completeTurn(active: Active, turn: Json): void {
    if (active.stop === 'rateLimited' || isRateLimited(turn.error)) this.finish(active, 'rateLimited')
    else if (active.stop) this.finish(active, 'interrupted', active.stop === 'timeout' ? 'timeout' : undefined)
    else if (turn.status === 'completed') this.finish(active, 'succeeded')
    else if (turn.status === 'interrupted') this.finish(active, 'interrupted')
    else this.finish(active, 'failed', 'turnFailed')
  }

  private finish(active: Active, status: ScheduleRun['status'], reason?: ScheduleRun['reason']): void {
    if (this.active !== active) return
    clearTimeout(active.deadline)
    this.active = undefined
    this.hosts[active.agent].detach(CLIENT_ID)
    for (const receive of this.requests.values()) receive(new RequestError())
    if (!active.uncertain) active.update({ status, threadId: active.threadId, reason }, active.resetAt)
  }
}

export function isScheduleClient(clientId: number): boolean { return clientId === CLIENT_ID }

function isRateLimited(value: unknown): boolean {
  const fields = asRecord(value)
  const info = fields.codexErrorInfo ?? asRecord(fields.data).codexErrorInfo
  if (typeof info === 'string' && /^(usageLimitExceeded|rateLimitExceeded|(?:apiKey|project|organization)SpendLimitExceeded)$/i.test(info)) return true
  return typeof fields.message === 'string' && /\b(?:429|rate.limit(?:ed| exceeded)?|usage limit|quota exceeded)\b/i.test(fields.message)
}

function limitReset(snapshot: Json): number | null {
  const now = Date.now()
  const rejection = typeof snapshot.rejectionResetsAt === 'number' ? snapshot.rejectionResetsAt * 1000 : 0
  if (Number.isFinite(rejection) && rejection > now) return rejection
  const windows = [asRecord(snapshot.primary), asRecord(snapshot.secondary)]
  // 两个窗口都用完时要等较晚的窗口。缺少确定的重置时间则由用户恢复。
  const blocked = windows.filter(({ usedPercent }) => typeof usedPercent === 'number' && usedPercent >= 100)
  const seconds = blocked.map(({ resetsAt }) => typeof resetsAt === 'number' ? resetsAt * 1000 : NaN)
  if (!seconds.length || seconds.some((at) => !Number.isFinite(at) || at <= now)) return null
  return Math.max(...seconds)
}
