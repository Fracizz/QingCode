/** 把推送事件转成对接收项目的同步任务。全部副作用经 deps 注入，便于测试。 */
import type { GitRemote } from '@/lib/git/git'
import { wslDistroNameFromPath } from '@/lib/wslWorkspace'
import type { Project } from '@/types'
import {
  allRemoteKeys,
  decideSync,
  keysOverlap,
  parseUpstream,
  remoteUrlKeys,
  shouldWatchProject,
  type GitPushSyncConfig,
  type RepositoryIdentity,
  type SyncTracking,
} from './core'

export type PushNotice = { projectPath: string; remote: string; branch: string }

export type SyncResultKind =
  | 'synced'
  | 'behind'
  | 'up-to-date'
  | 'ahead'
  | 'diverged'
  | 'no-upstream'
  | 'dirty-editors'
  | 'blocked'
  | 'failed'
  | 'offline'

export type SyncResult = { kind: SyncResultKind; commits?: number; detail?: string; at: number }

export type EngineDeps = {
  projects: () => Project[]
  config: () => GitPushSyncConfig
  isTrusted: (project: Project) => boolean
  dirtyEditorCount: (project: Project) => number
  /** 只读分支与上游引用的轻量查询；不能用全量 status，它会扫描整个工作区。 */
  getTracking: (path: string) => Promise<SyncTracking>
  getRemotes: (path: string) => Promise<GitRemote[]>
  /** 给出 target 时只获取这一个远程分支。 */
  fetch: (path: string, target?: { remote: string; branch: string }) => Promise<void>
  mergeFastForward: (path: string, upstream: string) => Promise<void>
  setWatches: (paths: string[]) => Promise<void>
  afterFastForward: (project: Project) => void
  record: (project: Project, result: SyncResult) => void
  notify: (project: Project, result: SyncResult) => void
  rememberIdentity: (projectId: string, keys: string[]) => void
  isLiveDetection: (path: string) => boolean
  now: () => number
  /** 当前打开的项目路径：它的同步任务排到所在机器队列的最前面。 */
  currentProjectPath?: () => string | null
}

type Origin = { keys: Set<string>; branch: string }
type Job = { project: Project; origin: Origin | null }
type MachineState = { queue: Job[]; workers: number; idle: Promise<void>; resolve: () => void }

const REMOTES_TTL_MS = 10 * 60 * 1000
const CATCH_UP_COOLDOWN_MS = 2 * 60 * 1000
/** 只提示一次的结果：重复事件不应反复打扰。 */
const NOTIFY_KINDS = new Set<SyncResultKind>(['synced', 'behind', 'diverged', 'dirty-editors', 'blocked'])

/**
 * 项目所在的机器。同一台机器上的 Git 任务限制并发，避免一条 SSH 连接上同时压太多 Git；
 * 不同机器之间并行，接收项目分布在多台机器时不必互相等待。
 */
export function syncMachineKey(project: Project): string {
  const ssh = /^ssh:\/\/([^/]+)/.exec(project.path)
  if (ssh) return `ssh:${project.connection_id || ssh[1]}`
  const distro = wslDistroNameFromPath(project.path)
  if (distro !== undefined || project.kind === 'wsl') return `wsl:${distro ?? ''}`
  return 'local'
}

/** 每台机器同时执行的同步任务数：本机 fetch 各走各的网络连接，SSH 共用一条连接所以更保守。 */
export function machineConcurrency(machine: string): number {
  return machine === 'local' ? 4 : 2
}

export function createGitPushSyncEngine(deps: EngineDeps) {
  const remotesCache = new Map<string, { remotes: GitRemote[]; at: number }>()
  const machines = new Map<string, MachineState>()
  const lastCatchUp = new Map<string, number>()
  const lastNoticeKey = new Map<string, string>()

  const receivers = () => {
    const { enabled, receivers: ids } = deps.config()
    if (!enabled) return []
    const allowed = new Set(ids)
    return deps.projects().filter(project => allowed.has(project.id) && !project.ephemeral)
  }

  /** 已知的仓库地址（不发命令）：缓存过期也可用，只用于预筛，最终仍以上游判断为准。 */
  function knownKeys(project: Project): string[] | null {
    const cached = remotesCache.get(project.path)
    if (cached) return allRemoteKeys(cached.remotes)
    const remembered = deps.config().identities[project.id]
    return remembered && remembered.length > 0 ? remembered : null
  }

  async function remotesOf(project: Project): Promise<GitRemote[]> {
    const cached = remotesCache.get(project.path)
    if (cached && deps.now() - cached.at < REMOTES_TTL_MS) return cached.remotes
    const remotes = await deps.getRemotes(project.path)
    remotesCache.set(project.path, { remotes, at: deps.now() })
    if (deps.config().receivers.includes(project.id)) {
      deps.rememberIdentity(project.id, allRemoteKeys(remotes))
    }
    return remotes
  }

  function publish(project: Project, result: SyncResult, noticeKey: string) {
    deps.record(project, result)
    if (!NOTIFY_KINDS.has(result.kind)) {
      // 回到正常状态后，同样的问题再次出现时需要重新提示。
      lastNoticeKey.delete(project.path)
      return
    }
    if (lastNoticeKey.get(project.path) === noticeKey) return
    lastNoticeKey.set(project.path, noticeKey)
    deps.notify(project, result)
  }

  async function run({ project, origin }: Job) {
    if (!deps.isTrusted(project)) return
    const at = deps.now()
    let remotes: GitRemote[]
    let status: SyncTracking
    try {
      [remotes, status] = await Promise.all([remotesOf(project), deps.getTracking(project.path)])
    } catch (reason) {
      deps.record(project, { kind: 'offline', detail: String(reason), at })
      return
    }
    const upstream = parseUpstream(status.upstream, remotes)
    if (origin) {
      // 只响应当前分支的上游，且必须是同一仓库；其他分支的推送不影响工作区。
      if (
        !upstream ||
        upstream.branch !== origin.branch ||
        !keysOverlap(remoteUrlKeys(upstream.remote), origin.keys)
      ) {
        return
      }
    }
    if (!upstream) {
      // 没有可解析的上游时 fetch 也无法判断，直接给出结论。
      publish(project, { kind: 'no-upstream', at }, 'no-upstream')
      return
    }
    try {
      // 只拉当前分支的上游：远程分支很多时比全量 fetch 快得多。
      await deps.fetch(project.path, { remote: upstream.remote.name, branch: upstream.branch })
      status = await deps.getTracking(project.path)
    } catch (reason) {
      publish(project, { kind: 'failed', detail: String(reason), at }, `failed:${reason}`)
      return
    }
    const decision = decideSync(status)
    if (decision !== 'fast-forward') {
      const commits = status.behind ?? 0
      publish(project, { kind: decision, commits, at }, `${decision}:${status.ahead}:${commits}`)
      return
    }
    const commits = status.behind ?? 0
    const noticeKey = `${status.upstream}:${commits}`
    if (deps.config().action === 'notify') {
      publish(project, { kind: 'behind', commits, at }, `behind:${noticeKey}`)
      return
    }
    // 未保存内容不在磁盘上，Git 无法保护，只能在这里拦下。
    if (deps.dirtyEditorCount(project) > 0) {
      publish(project, { kind: 'dirty-editors', commits, at }, `dirty:${noticeKey}`)
      return
    }
    try {
      await deps.mergeFastForward(project.path, status.upstream as string)
    } catch (reason) {
      publish(project, { kind: 'blocked', commits, detail: String(reason), at }, `blocked:${noticeKey}`)
      return
    }
    publish(project, { kind: 'synced', commits, at }, `synced:${noticeKey}:${at}`)
    deps.afterFastForward(project)
  }

  /** 一个工作线程：不断从本机队列取任务，队列空了就退出。首个 shift 同步发生。 */
  async function work(machine: string, state: MachineState) {
    for (let job = state.queue.shift(); job; job = state.queue.shift()) {
      try {
        await run(job)
      } catch (reason) {
        console.warn('git push sync job failed:', reason)
      }
    }
    state.workers -= 1
    if (state.workers === 0) {
      machines.delete(machine)
      state.resolve()
    }
  }

  function enqueue(job: Job): Promise<void> {
    const machine = syncMachineKey(job.project)
    let state = machines.get(machine)
    if (!state) {
      let resolve = () => {}
      const idle = new Promise<void>(done => (resolve = done))
      state = { queue: [], workers: 0, idle, resolve }
      machines.set(machine, state)
    }
    const { queue } = state
    const duplicate = queue.some(
      item => item.project.path === job.project.path && item.origin?.branch === job.origin?.branch,
    )
    if (!duplicate) {
      // 用户正在看的项目先同步；正在执行的任务已出队，不受影响。
      if (job.project.path === deps.currentProjectPath?.()) queue.unshift(job)
      else queue.push(job)
    }
    // 空闲名额直接开新线程；每个线程启动时同步取走一个任务。
    while (state.workers < machineConcurrency(machine) && queue.length > 0) {
      state.workers += 1
      void work(machine, state)
    }
    return state.idle
  }

  async function handlePush(notice: PushNotice) {
    if (!deps.config().enabled) return
    const source = deps.projects().find(project => project.path === notice.projectPath)
    if (!source) return
    let remotes: GitRemote[]
    try {
      remotes = await remotesOf(source)
    } catch {
      return
    }
    const remote = remotes.find(item => item.name === notice.remote)
    if (!remote) return
    const origin = { keys: new Set(remoteUrlKeys(remote)), branch: notice.branch }
    // 先用已知地址排除其他仓库的接收项目，免得它们排在同仓库项目前面跑 Git。
    // 地址未知的项目仍然入队，由任务内的上游判断兜底。
    const targets = receivers().filter(project => {
      if (project.path === source.path) return false
      const keys = knownKeys(project)
      return !keys || keysOverlap(keys, origin.keys)
    })
    await Promise.all(targets.map(project => enqueue({ project, origin })))
  }

  /** SCM 面板推送成功。已有 reflog 监听的项目由监听事件负责，避免重复。 */
  async function handlePanelPush(path: string) {
    if (!deps.config().enabled || deps.isLiveDetection(path)) return
    const source = deps.projects().find(project => project.path === path)
    if (!source) return
    try {
      const [remotes, status] = await Promise.all([remotesOf(source), deps.getTracking(path)])
      const upstream = parseUpstream(status.upstream, remotes)
      if (upstream) {
        await handlePush({ projectPath: path, remote: upstream.remote.name, branch: upstream.branch })
      }
    } catch {
      // 面板本身的推送已经成功，同步失败不影响它。
    }
  }

  /** 由用户动作触发的补查（启动、窗口聚焦、切换项目），带冷却避免重复 fetch。 */
  function catchUp(project: Project, options: { force?: boolean } = {}) {
    if (!receivers().some(item => item.path === project.path)) return Promise.resolve()
    const last = lastCatchUp.get(project.path) ?? Number.NEGATIVE_INFINITY
    if (!options.force && deps.now() - last < CATCH_UP_COOLDOWN_MS) return Promise.resolve()
    lastCatchUp.set(project.path, deps.now())
    return enqueue({ project, origin: null })
  }

  async function catchUpAll(options: { force?: boolean } = {}) {
    await Promise.all(receivers().map(project => catchUp(project, options)))
  }

  async function refreshWatches() {
    const config = deps.config()
    const active = receivers()
    if (active.length === 0) {
      await deps.setWatches([])
      return
    }
    const identities: RepositoryIdentity[] = active.map(project => ({
      projectId: project.id,
      keys: config.identities[project.id] ?? [],
    }))
    const candidates: Array<{ project: Project; keys: string[] }> = []
    for (const project of deps.projects()) {
      if (project.ephemeral || !deps.isTrusted(project)) continue
      try {
        const keys = allRemoteKeys(await remotesOf(project))
        const receiver = identities.find(item => item.projectId === project.id)
        if (receiver) receiver.keys = keys
        candidates.push({ project, keys })
      } catch {
        // 离线项目无法被监听，连接后的下一次刷新会加入。
      }
    }
    // 读完全部地址后再判断：来源项目可能排在接收项目之前。
    const targets = candidates
      .filter(
        ({ project, keys }) =>
          project.kind !== 'wsl' && shouldWatchProject({ projectId: project.id, keys }, identities),
      )
      .map(({ project }) => project.path)
    await deps.setWatches(targets)
  }

  return { handlePush, handlePanelPush, catchUp, catchUpAll, refreshWatches, idle: () => Promise.all([...machines.values()].map(state => state.idle)).then(() => undefined) }
}

export type GitPushSyncEngine = ReturnType<typeof createGitPushSyncEngine>
