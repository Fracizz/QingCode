import type { Project, SshConnection } from '../types'

// Session budgets, not merely concurrency limits: thousands of saved projects
// must not eventually establish thousands of transports or retain their trees.
export const SSH_WARMUP_PROJECT_LIMIT = 12
export const SSH_WARMUP_CONNECTION_LIMIT = 3
export const SSH_WARMUP_TREE_LIMIT = 256
export const SSH_WARMUP_TOTAL_TREE_LIMIT = 2048
export const SSH_WARMUP_DELAY_MS = 1500

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
}

/** One real background task at a time, including after cancellation. An aborted
 * IPC can still be executing natively, so never release its slot prematurely. */
export class SshWarmupQueue<T> {
  private entries = new Map<string, Entry<T>>()
  private admitted = new Set<string>()
  private connections = new Set<string>()
  private running = false
  private foreground = 0
  private paused = false
  private timer?: ReturnType<typeof setTimeout>
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
      if (wanted.get(key)?.version === entry.target.version) continue
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
        this.entries.set(key, {
          target,
          controller: new AbortController(),
          status: entry?.status.phase === 'ready' ? entry.status : { phase: 'ready' },
          weight: 0,
        })
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
      this.entries.set(key, {
        target,
        controller: new AbortController(),
        status: { phase: 'queued' },
        weight: 0,
      })
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

  /** Only join a started task. A queued target must run immediately in foreground. */
  take(path: string): Promise<T> | undefined {
    const entry = this.entries.get(path)
    if (!entry || entry.controller.signal.aborted) return
    if (entry.status.phase === 'preparing') return entry.promise
    if (entry.status.phase === 'ready') {
      if (entry.result !== undefined) return Promise.resolve(entry.result)
      return
    }
    entry.controller.abort()
    this.entries.delete(path)
    this.publish()
  }

  invalidateConnection(id: string) {
    for (const [key, entry] of this.entries) {
      if (entry.target.connectionId !== id) continue
      entry.controller.abort()
      this.entries.delete(key)
    }
    this.publish()
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
    for (const entry of this.entries.values()) entry.controller.abort()
    this.entries.clear()
    this.publish()
  }

  private publish() {
    this.options.changed(new Map([...this.entries].map(([path, entry]) => [path, entry.status])))
  }

  private schedule() {
    if (this.disposed || this.paused || this.foreground || this.running || this.timer) return
    if (![...this.entries.values()].some(entry => entry.status.phase === 'queued')) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drainOne()
    }, SSH_WARMUP_DELAY_MS)
  }

  private async drainOne() {
    if (this.disposed || this.paused || this.foreground || this.running) return
    const entry = [...this.entries.values()].find(item => item.status.phase === 'queued')
    if (!entry) return
    this.running = true
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
      entry.status = { phase: 'ready' }
    } catch (error) {
      if (!entry.controller.signal.aborted) {
        const detail = String(error).slice(0, 8192)
        entry.status = {
          phase: /密码|口令|密钥|指纹|认证|password|passphrase|fingerprint|authentication/i.test(
            detail
          )
            ? 'attention'
            : 'failed',
          detail,
        }
        // A failed host must not trigger twelve identical unattended attempts.
        for (const other of this.entries.values()) {
          if (
            other.status.phase === 'queued' &&
            other.target.connectionId === entry.target.connectionId
          ) {
            other.status = entry.status
          }
        }
      }
    } finally {
      // Drop the settled promise too: it otherwise retains an oversized tree.
      entry.promise = undefined
      this.running = false
      if (!this.disposed) this.publish()
      this.schedule()
    }
  }
}
