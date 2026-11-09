import type { Project, SshConnection } from '../types'

// Session budgets, not merely concurrency limits: thousands of saved projects
// must not eventually establish thousands of transports or retain their trees.
export const SSH_WARMUP_PROJECT_LIMIT = 12
export const SSH_WARMUP_CONNECTION_LIMIT = 8
/** 同时进行的预热任务总数。 */
export const SSH_WARMUP_CONCURRENCY = 4
/** 连接已成功准备过一个项目后，同一连接可并发的项目数；首个项目始终独占。 */
export const SSH_WARMUP_CONNECTION_CONCURRENCY = 3
export const SSH_WARMUP_TREE_LIMIT = 256
export const SSH_WARMUP_TOTAL_TREE_LIMIT = 2048
export const SSH_WARMUP_DELAY_MS = 1500
/** 失败后的自动重试间隔；用完后等待点击或服务更新完成。 */
export const SSH_WARMUP_RETRY_DELAYS_MS = [10_000, 30_000]
/** 已就绪的连接断开后重新排队的延迟，同时限制连接反复断开时的频率。 */
export const SSH_WARMUP_RECOVERY_DELAY_MS = 30_000

export type WarmupPhase = 'queued' | 'preparing' | 'ready' | 'attention' | 'failed'
export interface WarmupStatus {
  phase: WarmupPhase
  detail?: string
}
export interface WarmupTarget {
  project: Project
  connectionId: string
  version: string
}

/** O(N * 12), O(12) output; no full-list sort, timers, promises or IPC per project. */
export function selectWarmupTargets(
  projects: readonly Project[],
  connections: readonly SshConnection[],
  trusted: (project: Project) => boolean
): WarmupTarget[] {
  const byId = new Map(connections.map(connection => [connection.id, connection]))
  const top: WarmupTarget[] = []
  for (const project of projects) {
    if (project.hidden || !project.path.startsWith('ssh://') || !trusted(project)) continue
    const connectionId = project.connection_id || project.path.match(/^ssh:\/\/([^/]+)/)?.[1]
    const connection = connectionId ? byId.get(connectionId) : undefined
    if (!connection || !connection.host_key_fingerprint) continue
    let index = top.findIndex(item => item.project.last_opened_at < project.last_opened_at)
    if (index < 0) index = top.length
    if (index >= SSH_WARMUP_PROJECT_LIMIT) continue
    const target = {
      project,
      connectionId: connection.id,
      version: '',
    }
    top.splice(index, 0, target)
    if (top.length > SSH_WARMUP_PROJECT_LIMIT) top.pop()
  }
  const hosts = new Set<string>()
  return top
    .filter(target => {
      if (!hosts.has(target.connectionId) && hosts.size >= SSH_WARMUP_CONNECTION_LIMIT) return false
      hosts.add(target.connectionId)
      return true
    })
    .map(target => ({
      ...target,
      version: JSON.stringify([target.project.path, byId.get(target.connectionId)]),
    }))
}

interface Entry<T> {
  target: WarmupTarget
  controller: AbortController
  status: WarmupStatus
  promise?: Promise<T>
  result?: T
  weight: number
  /** 本条目的后台准备确实成功过；前台打开留下的 ready 不算。 */
  warmed?: boolean
  /** 连续失败次数，成功后清零。 */
  attempts: number
  /** 真正执行过的次数，重试时优先换一个没跑过的项目，避免单个失效项目挡住整条连接。 */
  runs: number
  /** 到点后才允许重新排队。 */
  retryAt?: number
}

/** The first task on a connection runs alone; siblings fan out only after it proves
 * the connection works. Slots outlive cancellation: an aborted IPC can still be
 * executing natively, so never release one prematurely. */
export class SshWarmupQueue<T> {
  private entries = new Map<string, Entry<T>>()
  private admitted = new Set<string>()
  private connections = new Set<string>()
  private runningConnections = new Map<string, number>()
  private runningTasks = 0
  private provenConnections = new Set<string>()
  private foreground = 0
  private paused = false
  private timer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private activePath?: string

  constructor(
    private options: {
      run: (target: WarmupTarget, signal: AbortSignal) => Promise<T>
      weight: (result: T) => number
      changed: (statuses: ReadonlyMap<string, WarmupStatus>) => void
    }
  ) {}

  update(targets: readonly WarmupTarget[], activePath?: string) {
    if (this.disposed) return
    const activated = activePath !== this.activePath
    this.activePath = activePath
    const wanted = new Map(targets.map(target => [target.project.path, target]))
    for (const [key, entry] of this.entries) {
      const next = wanted.get(key)
      if (next?.version === entry.target.version) continue
      // 连接配置变了，之前“这条连接可用”的结论不再成立。
      if (next) this.provenConnections.delete(entry.target.connectionId)
      entry.controller.abort()
      this.entries.delete(key)
    }
    for (const target of targets) {
      const key = target.project.path
      // The active project has completed foreground opening. Keep its readiness
      // when switching away, but discard the pre-open tree so it cannot go stale.
      if (key === activePath) {
        // A disconnect/configuration change must stay invalidated until the
        // project is opened again; ordinary list refreshes do not prove readiness.
        if (!activated) continue
        const entry = this.entries.get(key)
        entry?.controller.abort()
        this.entries.set(key, this.newEntry(target, entry?.status.phase === 'ready' ? entry.status : { phase: 'ready' }))
        continue
      }
      if (this.entries.has(key)) continue
      if (!this.admitted.has(key) && this.admitted.size >= SSH_WARMUP_PROJECT_LIMIT) continue
      if (
        !this.connections.has(target.connectionId) &&
        this.connections.size >= SSH_WARMUP_CONNECTION_LIMIT
      )
        continue
      this.admitted.add(key)
      this.connections.add(target.connectionId)
      this.entries.set(key, this.newEntry(target, { phase: 'queued' }))
    }
    this.publish()
    this.schedule()
  }

  setPaused(paused: boolean) {
    this.paused = paused
    this.schedule()
  }

  beginForeground(): () => void {
    this.foreground++
    clearTimeout(this.timer)
    this.timer = undefined
    return () => {
      this.foreground--
      this.schedule()
    }
  }

  /**
   * Only join a started task. A queued target must run immediately in foreground.
   * 返回 Promise 表示后台准备已完成或进行中；resolve 为 undefined 表示服务已就绪、
   * 只是目录结果超出预算没有保留。
   */
  take(path: string): Promise<T | undefined> | undefined {
    const entry = this.entries.get(path)
    if (!entry || entry.controller.signal.aborted) return
    if (entry.status.phase === 'preparing') return entry.promise
    if (entry.status.phase === 'ready') {
      if (entry.warmed) return Promise.resolve(entry.result)
      return
    }
    entry.controller.abort()
    this.entries.delete(path)
    this.publish()
  }

  /** 用户主动断开或连接被移除：作废且不自动恢复。 */
  invalidateConnection(id: string) {
    this.provenConnections.delete(id)
    for (const [key, entry] of this.entries) {
      if (entry.target.connectionId !== id) continue
      entry.controller.abort()
      this.entries.delete(key)
    }
    this.publish()
  }

  /** 已就绪的连接意外断开：结果作废，延迟后重新预热，当前项目等下次打开。 */
  connectionLost(id: string) {
    this.provenConnections.delete(id)
    const retryAt = Date.now() + SSH_WARMUP_RECOVERY_DELAY_MS
    for (const [key, entry] of this.entries) {
      if (entry.target.connectionId !== id) continue
      entry.controller.abort()
      if (key === this.activePath) this.entries.delete(key)
      else this.entries.set(key, { ...this.newEntry(entry.target, { phase: 'queued' }), retryAt })
    }
    this.publish()
    this.armRetry()
  }

  /** 远端服务更新完成：之前的失败和退避都不再有效，立即重新排队（需认证的除外）。 */
  retryFailed() {
    for (const entry of this.entries.values()) {
      if (entry.status.phase !== 'failed' && entry.retryAt === undefined) continue
      entry.status = { phase: 'queued' }
      entry.retryAt = undefined
      entry.attempts = 0
    }
    this.publish()
    this.armRetry()
    this.schedule()
  }

  invalidateRoot(path: string) {
    const entry = this.entries.get(path)
    entry?.controller.abort()
    this.entries.delete(path)
    this.publish()
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
    this.publish()
  }

  private publish() {
    this.options.changed(new Map([...this.entries].map(([path, entry]) => [path, entry.status])))
  }

  private newEntry(target: WarmupTarget, status: WarmupStatus): Entry<T> {
    return { target, controller: new AbortController(), status, weight: 0, attempts: 0, runs: 0 }
  }

  /** 空闲连接优先，保证慢主机不会被已验证连接的后续项目挤掉名额。 */
  private nextQueued(): Entry<T> | undefined {
    if (this.runningTasks >= SSH_WARMUP_CONCURRENCY) return
    let idle: Entry<T> | undefined
    let sibling: Entry<T> | undefined
    for (const item of this.entries.values()) {
      if (item.status.phase !== 'queued' || item.retryAt !== undefined) continue
      const running = this.runningConnections.get(item.target.connectionId) ?? 0
      if (running === 0) {
        if (!idle || item.runs < idle.runs) idle = item
      } else if (
        !sibling &&
        running < SSH_WARMUP_CONNECTION_CONCURRENCY &&
        this.provenConnections.has(item.target.connectionId)
      ) {
        sibling = item
      }
    }
    return idle ?? sibling
  }

  /** 全队列共用一个定时器，项目再多也不增加定时器数量。 */
  private armRetry() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.disposed) return
    let next = Infinity
    for (const entry of this.entries.values()) {
      if (entry.retryAt !== undefined) next = Math.min(next, entry.retryAt)
    }
    if (next === Infinity) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      const now = Date.now()
      for (const entry of this.entries.values()) {
        if (entry.retryAt === undefined || entry.retryAt > now) continue
        entry.retryAt = undefined
        entry.status = { phase: 'queued' }
      }
      this.publish()
      this.armRetry()
      this.schedule()
    }, Math.max(0, next - Date.now()))
  }

  private recordFailure(entry: Entry<T>, error: unknown) {
    const detail = String(error).slice(0, 8192)
    const attention = /密码|口令|密钥|指纹|认证|password|passphrase|fingerprint|authentication/i.test(detail)
    entry.status = { phase: attention ? 'attention' : 'failed', detail }
    entry.attempts++
    const delay = attention ? undefined : SSH_WARMUP_RETRY_DELAYS_MS[entry.attempts - 1]
    entry.retryAt = delay === undefined ? undefined : Date.now() + delay
    // A failed host must not trigger twelve identical unattended attempts. 连接已
    // 验证可用时失败多半只与该项目有关，不牵连同连接的其他项目。
    if (this.provenConnections.has(entry.target.connectionId)) return
    for (const other of this.entries.values()) {
      if (other.status.phase !== 'queued' || other.target.connectionId !== entry.target.connectionId) continue
      other.status = entry.status
      other.attempts = entry.attempts
      other.retryAt = entry.retryAt
    }
  }

  private schedule() {
    if (this.disposed || this.paused || this.foreground || this.timer || !this.nextQueued()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.drain()
    }, SSH_WARMUP_DELAY_MS)
  }

  /** 延迟只用于启动和前台结束后的让路；任务结束后空出的名额立即接续。 */
  private drain() {
    if (this.disposed || this.paused || this.foreground) return
    for (let entry = this.nextQueued(); entry; entry = this.nextQueued()) void this.runEntry(entry)
  }

  private async runEntry(entry: Entry<T>) {
    const { connectionId } = entry.target
    this.runningConnections.set(connectionId, (this.runningConnections.get(connectionId) ?? 0) + 1)
    this.runningTasks++
    entry.runs++
    entry.status = { phase: 'preparing' }
    entry.promise = Promise.resolve().then(() =>
      this.options.run(entry.target, entry.controller.signal)
    )
    this.publish()
    try {
      const result = await entry.promise
      if (entry.controller.signal.aborted) return
      const weight = this.options.weight(result)
      const total = [...this.entries.values()].reduce((sum, item) => sum + item.weight, 0)
      if (weight <= SSH_WARMUP_TREE_LIMIT && total + weight <= SSH_WARMUP_TOTAL_TREE_LIMIT) {
        entry.result = result
        entry.weight = weight
      }
      entry.warmed = true
      entry.attempts = 0
      this.provenConnections.add(connectionId)
      entry.status = { phase: 'ready' }
    } catch (error) {
      if (!entry.controller.signal.aborted) {
        this.recordFailure(entry, error)
        this.armRetry()
      }
    } finally {
      // Drop the settled promise too: it otherwise retains an oversized tree.
      entry.promise = undefined
      const remaining = (this.runningConnections.get(connectionId) ?? 1) - 1
      if (remaining > 0) this.runningConnections.set(connectionId, remaining)
      else this.runningConnections.delete(connectionId)
      this.runningTasks--
      if (!this.disposed) this.publish()
      if (!this.timer) this.drain()
    }
  }
}
