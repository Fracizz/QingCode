/** 把推送事件转成对接收项目的同步任务。全部副作用经 deps 注入，便于测试。 */
import type { GitRemote, GitStatus } from '@/lib/git/git'
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
  getStatus: (path: string) => Promise<GitStatus>
  getRemotes: (path: string) => Promise<GitRemote[]>
  fetch: (path: string) => Promise<void>
  mergeFastForward: (path: string, upstream: string) => Promise<void>
  setWatches: (paths: string[]) => Promise<void>
  afterFastForward: (project: Project) => void
  record: (project: Project, result: SyncResult) => void
  notify: (project: Project, result: SyncResult) => void
  rememberIdentity: (projectId: string, keys: string[]) => void
  isLiveDetection: (path: string) => boolean
  now: () => number
}

type Origin = { keys: Set<string>; branch: string }
type Job = { project: Project; origin: Origin | null }

const REMOTES_TTL_MS = 10 * 60 * 1000
const CATCH_UP_COOLDOWN_MS = 2 * 60 * 1000
/** 只提示一次的结果：重复事件不应反复打扰。 */
const NOTIFY_KINDS = new Set<SyncResultKind>(['synced', 'behind', 'diverged', 'dirty-editors', 'blocked'])

export function createGitPushSyncEngine(deps: EngineDeps) {
  const remotesCache = new Map<string, { remotes: GitRemote[]; at: number }>()
  const queue: Job[] = []
  const lastCatchUp = new Map<string, number>()
  const lastNoticeKey = new Map<string, string>()
  let draining: Promise<void> | null = null

  const receivers = () => {
    const { enabled, receivers: ids } = deps.config()
    if (!enabled) return []
    const allowed = new Set(ids)
    return deps.projects().filter(project => allowed.has(project.id) && !project.ephemeral)
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
    let status: GitStatus
    try {
      remotes = await remotesOf(project)
      status = await deps.getStatus(project.path)
    } catch (reason) {
      deps.record(project, { kind: 'offline', detail: String(reason), at })
      return
    }
    if (origin) {
      // 只响应当前分支的上游，且必须是同一仓库；其他分支的推送不影响工作区。
      const upstream = parseUpstream(status.upstream, remotes)
      if (
        !upstream ||
        upstream.branch !== origin.branch ||
        !keysOverlap(remoteUrlKeys(upstream.remote), origin.keys)
      ) {
        return
      }
    }
    try {
      await deps.fetch(project.path)
      status = await deps.getStatus(project.path)
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

  function drain(): Promise<void> {
    draining ??= (async () => {
      // 全局串行：同步是后台任务，不应让多台远端同时跑 Git。
      while (queue.length > 0) {
        const job = queue.shift() as Job
        try {
          await run(job)
        } catch (reason) {
          console.warn('git push sync job failed:', reason)
        }
      }
      draining = null
    })()
    return draining
  }

  function enqueue(job: Job) {
    const duplicate = queue.some(
      item => item.project.path === job.project.path && item.origin?.branch === job.origin?.branch,
    )
    if (!duplicate) queue.push(job)
    return drain()
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
    await Promise.all(
      receivers()
        .filter(project => project.path !== source.path)
        .map(project => enqueue({ project, origin })),
    )
  }

  /** SCM 面板推送成功。已有 reflog 监听的项目由监听事件负责，避免重复。 */
  async function handlePanelPush(path: string) {
    if (!deps.config().enabled || deps.isLiveDetection(path)) return
    const source = deps.projects().find(project => project.path === path)
    if (!source) return
    try {
      const [remotes, status] = await Promise.all([remotesOf(source), deps.getStatus(path)])
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

  return { handlePush, handlePanelPush, catchUp, catchUpAll, refreshWatches, idle: () => draining ?? Promise.resolve() }
}

export type GitPushSyncEngine = ReturnType<typeof createGitPushSyncEngine>
