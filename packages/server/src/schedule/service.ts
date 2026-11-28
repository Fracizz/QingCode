import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  isAgentKind, type AgentKind, type ScheduleInput, type ScheduleRun,
  type ScheduleRuntime, type ScheduleSummary,
} from '@qn/protocol'
import { nativeAgentCwd, normalizePathForCompare } from '../workspace/paths'
import { WorkspaceError } from '../workspace/index'
import { nextScheduleAt, parseCadence } from './cadence'
import { runtimeConfig, runtimePath, type ScheduleRunner } from './runner'

const MAX_TASKS = 100
const KEEP_RUNS = 50
const MAX_SLEEP = 60_000
const LATE_GRACE = 90_000

type Json = Record<string, unknown>
type Task = Omit<ScheduleInput, 'id' | 'piAcknowledged'> & {
  id: string
  realCwd: string
  runtime: ScheduleRuntime
  nextRunAt: number | null
  runs: ScheduleRun[]
}
type Store = { version: 1; tasks: Task[]; blockedUntil: Partial<Record<AgentKind, number | null>> }

const asRecord = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}

const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? normalizePathForCompare(a) === normalizePathForCompare(b)
  : a === b

const unfinished = (run: ScheduleRun): boolean => run.status === 'running' || run.status === 'waiting'

export class ScheduleService {
  private readonly file: string
  private data: Store = { version: 1, tasks: [], blockedUntil: {} }
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private storageFailed = false

  constructor(
    stateDir: string,
    private readonly runner: Pick<ScheduleRunner, 'busy' | 'start' | 'stop'>,
    private readonly changed: (cwd: string) => void,
    private readonly log: (message: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(stateDir, 'schedules.json')
    try {
      this.recover()
    } catch {
      this.failStorage()
    }
    this.arm()
  }

  get keepAlive(): boolean { return !this.storageFailed && this.data.tasks.some((task) => task.enabled) }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  request(method: string, params: Json): unknown {
    if (method === 'schedule.preview') {
      const cadence = parseCadence(params.cadence)
      if (!cadence) throw new WorkspaceError('params', '定时规则无效')
      let after = this.now()
      return Array.from({ length: 3 }, () => (after = nextScheduleAt(cadence, after)))
    }
    if (this.storageFailed) throw new WorkspaceError('internal', '定时任务存储不可用')
    const cwd = projectPath(params.cwd)
    const tasks = this.data.tasks.filter((task) => samePath(task.cwd, cwd))
    if (method === 'schedule.list') return tasks.map((task) => this.summary(task))
    if (method === 'schedule.pauseProject') {
      const enabled = tasks.filter((task) => task.enabled)
      if (enabled.length) {
        const ids = new Set(enabled.map((task) => task.id))
        this.commit({
          ...this.data, tasks: this.data.tasks.map((task) =>
            ids.has(task.id) ? { ...task, enabled: false, nextRunAt: null } : task),
        }, cwd)
      }
      this.runner.stop(new Set(tasks.map(({ id }) => id)))
      return { paused: enabled.length }
    }
    const task = tasks.find(({ id }) => id === params.id)
    if (method === 'schedule.upsert' && params.id === undefined) return this.saveTask(cwd, params)
    if (!task) throw new WorkspaceError('not_found', '定时任务不存在')
    switch (method) {
      case 'schedule.runs':
        return task.runs
      case 'schedule.upsert':
        return this.saveTask(cwd, params, task)
      case 'schedule.delete':
        if (task.runs.some(unfinished)) throw new WorkspaceError('conflict', '任务正在运行，请等待结束后再删除')
        this.commit({ ...this.data, tasks: this.data.tasks.filter(({ id }) => id !== task.id) }, task.cwd)
        return {}
      case 'schedule.setEnabled': {
        if (typeof params.enabled !== 'boolean') throw new WorkspaceError('params', '缺少任务启用状态')
        if (params.enabled) this.checkProject(task)
        const updated = { ...task, enabled: params.enabled, nextRunAt: params.enabled ? this.next(task) : null }
        this.put(updated, params.enabled)
        return this.summary(updated)
      }
      case 'schedule.runNow':
        if (this.runner.busy) throw new WorkspaceError('conflict', '当前目标已有定时任务运行')
        if (this.blockedUntil(task.agent) || this.data.blockedUntil[task.agent] === null) {
          throw new WorkspaceError('conflict', 'Agent 额度尚未恢复')
        }
        this.checkProject(task)
        return { runId: this.dispatch(task, null) }
      default:
        throw new WorkspaceError('params', '未知定时任务方法')
    }
  }

  private saveTask(cwd: string, params: Json, previous?: Task): ScheduleSummary {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''
    const cadence = parseCadence(params.cadence)
    const { agent, enabled } = params
    if (!name || name.length > 120 || !prompt || prompt.length > 16_000 ||
      !isAgentKind(agent) || !cadence || typeof enabled !== 'boolean') {
      throw new WorkspaceError('params', '请填写有效的任务名称、Agent、提示词与定时规则')
    }
    if (agent === 'pi' && params.piAcknowledged !== true) {
      throw new WorkspaceError('params', '请确认 pi 的工具执行权限')
    }
    if (!previous && this.data.tasks.length >= MAX_TASKS) throw new WorkspaceError('conflict', '当前目标的定时任务已达上限')
    if (previous?.runs.some(unfinished)) throw new WorkspaceError('conflict', '任务正在运行，请等待结束后再编辑')
    const realCwd = resolveProject(cwd)
    const runtime = parseRuntime(agent, params.runtime)
    const task: Task = {
      id: previous?.id ?? randomUUID(), cwd, realCwd, name, agent, prompt, cadence, enabled,
      runtime, nextRunAt: null, runs: previous?.runs ?? [],
    }
    task.nextRunAt = enabled ? this.next(task) : null
    this.put(task, enabled)
    return this.summary(task)
  }

  private summary(task: Task): ScheduleSummary {
    const { id, cwd, name, agent, prompt, cadence, enabled, nextRunAt, runs } = task
    return {
      id, cwd, name, agent, prompt, cadence, enabled, nextRunAt,
      rateLimitedUntil: this.blockedUntil(agent), requiresManualResume: this.data.blockedUntil[agent] === null,
      activeRun: runs.find(unfinished), lastRun: runs[0],
    }
  }

  private blockedUntil(agent: AgentKind): number | null {
    const until = this.data.blockedUntil[agent] ?? 0
    return until > this.now() ? until : null
  }

  private next(task: Task): number {
    return nextScheduleAt(task.cadence, Math.max(this.now(), this.blockedUntil(task.agent) ?? 0))
  }

  private checkProject(task: Task): void {
    if (!samePath(resolveProject(task.cwd), task.realCwd)) {
      throw new WorkspaceError('conflict', '项目路径已变更，请重新保存定时任务')
    }
  }

  private recover(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const parsed = asRecord(JSON.parse(raw))
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error('Invalid schedule store version')
    for (const item of parsed.tasks) {
      const task = asRecord(item)
      if (typeof task.id !== 'string' || !isAgentKind(task.agent) || !parseCadence(task.cadence) ||
        typeof task.cwd !== 'string' || typeof task.realCwd !== 'string' || typeof task.name !== 'string' ||
        typeof task.prompt !== 'string' || typeof task.enabled !== 'boolean' || !Array.isArray(task.runs) ||
        (task.nextRunAt !== null && typeof task.nextRunAt !== 'number')) throw new Error('Invalid schedule store contents')
    }
    const blockedUntil: Store['blockedUntil'] = {}
    for (const [agent, until] of Object.entries(asRecord(parsed.blockedUntil))) {
      if (isAgentKind(agent) && (until === null || (typeof until === 'number' && Number.isFinite(until)))) blockedUntil[agent] = until
    }
    this.data = { version: 1, tasks: parsed.tasks, blockedUntil }
    const now = this.now()
    const recovered = this.data.tasks.map((task): Task => {
      const runs = task.runs.map((run): ScheduleRun => unfinished(run)
        ? { ...run, status: 'interrupted', reason: 'daemonRestarted', finishedAt: now }
        : run)
      const nextRunAt = task.enabled && task.nextRunAt !== null && task.nextRunAt <= now ? this.next(task) : task.nextRunAt
      const missed = nextRunAt !== task.nextRunAt && task.nextRunAt !== null
        ? [this.makeRun(task.agent, task.nextRunAt, 'missed')]
        : []
      return { ...task, runs: [...missed, ...runs].slice(0, KEEP_RUNS), nextRunAt }
    })
    this.write({ ...this.data, tasks: recovered })
  }

  private arm(): void {
    clearTimeout(this.timer)
    if (this.stopped || this.storageFailed) return
    const next = Math.min(...this.data.tasks.map(({ nextRunAt }) => nextRunAt ?? Infinity))
    if (!Number.isFinite(next)) return
    this.timer = setTimeout(() => {
      try {
        this.tick()
        this.arm()
      } catch {
        this.failStorage()
      }
    }, Math.max(1, Math.min(MAX_SLEEP, next - this.now()))).unref()
  }

  private tick(): void {
    const now = this.now()
    for (const task of this.data.tasks) {
      const at = task.nextRunAt
      if (!task.enabled || at === null || at > now) continue
      if (this.blockedUntil(task.agent)) {
        this.put({ ...task, nextRunAt: this.next(task) })
      } else if (now - at > LATE_GRACE || this.runner.busy) {
        const status = now - at > LATE_GRACE ? 'missed' : 'skipped'
        const run = this.makeRun(task.agent, at, status, status === 'skipped' ? 'busy' : undefined)
        this.put({ ...this.withRun(task, run), nextRunAt: this.next(task) })
      } else {
        try {
          this.checkProject(task)
        } catch {
          const run = this.makeRun(task.agent, at, 'failed', 'projectUnavailable')
          this.put({ ...this.withRun(task, run), enabled: false, nextRunAt: null })
          continue
        }
        this.dispatch(task, at)
      }
    }
  }

  private dispatch(task: Task, scheduledAt: number | null): string {
    const run = this.makeRun(task.agent, scheduledAt, 'running')
    // 游标和运行记录先在同一原子写入里落盘，再调用 Agent。
    this.put({ ...this.withRun(task, run), nextRunAt: scheduledAt === null ? task.nextRunAt : this.next(task) })
    this.runner.start({
      taskId: task.id, agent: task.agent, cwd: task.realCwd, prompt: task.prompt, runtime: task.runtime,
      update: (update, resetAt) => {
        if (this.stopped || this.storageFailed) return false
        try {
          const current = this.data.tasks.find(({ id }) => id === task.id)
          const latest = current?.runs.find(({ id }) => id === run.id)
          if (!current || !latest || !unfinished(latest)) return false
          const result = { ...latest, ...update, finishedAt: unfinished({ ...latest, ...update }) ? null : this.now() }
          const updated = { ...current, runs: current.runs.map((item) => item.id === run.id ? result : item) }
          if (result.status === 'rateLimited') this.rateLimit(updated, resetAt)
          else this.put(updated)
          return true
        } catch {
          this.failStorage()
          return false
        }
      },
    })
    return run.id
  }

  private rateLimit(updated: Task, resetAt: number | null | undefined): void {
    const blockedUntil = { ...this.data.blockedUntil }
    blockedUntil[updated.agent] = resetAt ?? null
    const tasks = this.data.tasks.map((existing) => {
      const task = existing.id === updated.id ? updated : existing
      if (task.agent !== updated.agent || !task.enabled) return task
      if (!resetAt) return { ...task, enabled: false, nextRunAt: null }
      return { ...task, nextRunAt: nextScheduleAt(task.cadence, resetAt) }
    })
    this.commit({ ...this.data, blockedUntil, tasks }, ...new Set(tasks.filter(({ agent }) => agent === updated.agent).map(({ cwd }) => cwd)))
  }

  private makeRun(agent: AgentKind, scheduledAt: number | null, status: ScheduleRun['status'], reason?: ScheduleRun['reason']): ScheduleRun {
    const now = this.now()
    return {
      id: randomUUID(), agent, scheduledAt, status, reason,
      startedAt: status === 'running' ? now : null, finishedAt: status === 'running' ? null : now,
    }
  }

  private withRun(task: Task, run: ScheduleRun): Task {
    // 运行中的记录可能被较新的跳过记录挤到后面，结束前必须保留。
    const records = [run, ...task.runs]
    const overflow = records.slice(KEEP_RUNS).find(unfinished)
    return { ...task, runs: overflow ? [...records.slice(0, KEEP_RUNS - 1), overflow] : records.slice(0, KEEP_RUNS) }
  }

  private put(task: Task, resume = false): void {
    const present = this.data.tasks.some(({ id }) => id === task.id)
    const tasks = present ? this.data.tasks.map((other) => other.id === task.id ? task : other) : [...this.data.tasks, task]
    if (resume && this.data.blockedUntil[task.agent] === null) {
      const blockedUntil = { ...this.data.blockedUntil }
      delete blockedUntil[task.agent]
      this.commit({ ...this.data, tasks, blockedUntil },
        ...new Set(tasks.filter(({ agent }) => agent === task.agent).map(({ cwd }) => cwd)))
    } else {
      this.commit({ ...this.data, tasks }, task.cwd)
    }
  }

  private commit(data: Store, ...paths: string[]): void {
    this.write(data)
    this.arm()
    for (const cwd of paths) this.changed(cwd)
  }

  private write(data: Store): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      const fd = fs.openSync(tmp, 'w', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(data), 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, this.file)
      this.data = data
    } catch {
      this.failStorage()
      throw new WorkspaceError('internal', '定时任务保存失败')
    }
  }

  private failStorage(): void {
    if (this.storageFailed) return
    this.storageFailed = true
    clearTimeout(this.timer)
    this.log('定时任务存储不可用，调度已停止') // i18n-ignore: 仅进日志
  }
}

function projectPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.length > 4096) {
    throw new WorkspaceError('params', '项目路径无效')
  }
  const native = nativeAgentCwd(raw)
  const full = process.platform === 'win32' && /^[a-z]:$/i.test(native) ? `${native}\\` : native
  if (!path.isAbsolute(full)) throw new WorkspaceError('params', '定时任务需要绝对项目路径')
  const normalized = path.normalize(full)
  const root = path.parse(normalized).root
  return normalized === root ? root : normalized.replace(process.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
}

function resolveProject(cwd: string): string {
  try {
    const resolved = fs.realpathSync.native(cwd)
    if (fs.statSync(resolved).isDirectory()) return resolved
  } catch {
    // 项目目录不存在或已失去访问权。
  }
  throw new WorkspaceError('not_found', '定时任务的项目目录不可用')
}

function parseRuntime(agent: AgentKind, value: unknown): ScheduleRuntime {
  const raw = asRecord(value)
  const options: ScheduleRuntime = {}
  const keys = agent === 'codex' ? ['codexPath', 'codexHome'] as const
    : agent === 'claude' ? ['claudePath', 'claudeConfigDir'] as const : ['piPath'] as const
  for (const key of keys) {
    const item = raw[key]
    if (item === undefined) continue
    if (typeof item !== 'string' || item.length > 1024 || item.includes('\0')) {
      throw new WorkspaceError('params', 'Agent 路径配置无效')
    }
    options[key] = item
  }
  const executable = runtimePath(agent, options)
  if (executable && !path.isAbsolute(executable)) throw new WorkspaceError('params', 'Agent 可执行文件需要绝对路径')
  runtimeConfig(agent, options)
  return options
}
