import { create } from 'zustand'
import type { GitBranch, GitCommit, GitStatusResult } from '@qn/protocol'
import { t } from '@qn/codex-client'
import { serverCall } from '../workspace/serverCall'
import {
  branchesStale,
  describeGitError,
  mergeLogFirstPage,
  repoKey,
  sameBranches,
  sameStatus,
} from './gitModel'

// 面板可见期间轮询与窗口聚焦刷新在模块级维护，组件挂载/卸载只登记与注销。
const POLL_MS = 5_000
const LOG_PAGE = 30

export type GitCommitFile = { path: string; origPath?: string; status: string }
export type GitBranches = {
  current: string | null
  local: GitBranch[]
  remote: GitBranch[]
}

export type GitRepoState = {
  status: GitStatusResult | null
  branches: GitBranches | null
  commits: GitCommit[]
  commitFiles: Record<string, GitCommitFile[]>
  hasMore: boolean
  logLoading: boolean
  loading: boolean
  /** 读取 status/branches/log 的错误；errorCode 用于空态区分 not_repo / git_missing。 */
  error: string | null
  errorCode: string | null
  /** 操作失败单独保留，避免随后一次成功刷新把提示抹掉。 */
  operationError: string | null
  /** git.log 失败不影响 status / branches 展示，单独给历史页用。 */
  historyError: string | null
  /** 非空时表示有操作在跑，按钮据此禁用，防止重复点击。 */
  operation: string | null
}

const emptyRepo = (): GitRepoState => ({
  status: null,
  branches: null,
  commits: [],
  commitFiles: {},
  hasMore: false,
  logLoading: false,
  loading: false,
  error: null,
  errorCode: null,
  operationError: null,
  historyError: null,
  operation: null,
})

type RepoPatch = Partial<GitRepoState> | ((prev: GitRepoState) => Partial<GitRepoState>)

export type GitStore = {
  repos: Record<string, GitRepoState>
  /** includeLog=false 时只刷 status/branches，供高频轮询使用。 */
  refresh: (targetId: string, cwd: string, includeLog?: boolean) => Promise<void>
  loadMore: (targetId: string, cwd: string) => Promise<void>
  loadCommitFiles: (targetId: string, cwd: string, commit: string) => Promise<GitCommitFile[]>
  stage: (targetId: string, cwd: string, paths: string[]) => Promise<boolean>
  unstage: (targetId: string, cwd: string, paths: string[]) => Promise<boolean>
  discard: (
    targetId: string,
    cwd: string,
    paths: string[],
    includeUntracked?: boolean,
  ) => Promise<boolean>
  commit: (targetId: string, cwd: string, message: string, amend?: boolean) => Promise<boolean>
  switchBranch: (targetId: string, cwd: string, branch: string, create?: boolean) => Promise<boolean>
  fetch: (targetId: string, cwd: string) => Promise<boolean>
  pull: (targetId: string, cwd: string) => Promise<boolean>
  push: (targetId: string, cwd: string) => Promise<boolean>
  clearError: (targetId: string, cwd: string) => void
}

// 同一仓库的并发刷新/分页/提交文件读取合并，避免轮询与操作互相覆盖。
const refreshing = new Map<string, Promise<void>>()
// 合并在途刷新时保留「强度」：整刷请求搭上轮询的车也要带上 log。
const refreshWithLog = new Map<string, boolean>()
const paging = new Set<string>()
const readingFiles = new Map<string, Promise<GitCommitFile[]>>()

type RepoContext = { targetId: string; cwd: string; count: number }
const visibleRepos = new Map<string, RepoContext>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let listenersAttached = false

const isHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true

function refreshVisible(includeLog: boolean): void {
  if (isHidden()) return
  const state = useGit.getState()
  for (const [key, context] of visibleRepos) {
    // 操作期间的状态以操作结束后的整刷为准，跳过轮询。
    if (state.repos[key]?.operation) continue
    void state.refresh(context.targetId, context.cwd, includeLog)
  }
}

/** 面板可见时调用；返回注销函数。不可见（卸载 / IntersectionObserver 判定隐藏）时注销即停。 */
export function startGitPolling(targetId: string, cwd: string): () => void {
  const key = repoKey(targetId, cwd)
  const existing = visibleRepos.get(key)
  if (existing) existing.count += 1
  else visibleRepos.set(key, { targetId, cwd, count: 1 })

  if (!listenersAttached && typeof window !== 'undefined' && typeof document !== 'undefined') {
    // 回到前台/窗口聚焦时整刷（含历史），常规轮询只看工作区与分支。
    const onForeground = () => refreshVisible(true)
    window.addEventListener('focus', onForeground)
    document.addEventListener('visibilitychange', () => {
      if (!isHidden()) onForeground()
    })
    listenersAttached = true
  }
  if (pollTimer === null) pollTimer = setInterval(() => refreshVisible(false), POLL_MS)

  let done = false
  return () => {
    if (done) return
    done = true
    stopGitPolling(targetId, cwd)
  }
}

export function stopGitPolling(targetId: string, cwd: string): void {
  const key = repoKey(targetId, cwd)
  const entry = visibleRepos.get(key)
  if (!entry) return
  entry.count -= 1
  if (entry.count > 0) return
  visibleRepos.delete(key)
  if (visibleRepos.size === 0 && pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export const useGit = create<GitStore>((set, get) => {
  const repo = (key: string): GitRepoState => get().repos[key] ?? emptyRepo()
  const patch = (key: string, update: RepoPatch): void => {
    set((state) => {
      const prev = state.repos[key] ?? emptyRepo()
      const next = typeof update === 'function' ? update(prev) : update
      // 空补丁不产生新引用，订阅方不会重渲染。
      if (state.repos[key] && Object.keys(next).length === 0) return state
      return { repos: { ...state.repos, [key]: { ...prev, ...next } } }
    })
  }

  const run = async (
    targetId: string,
    cwd: string,
    name: string,
    work: () => Promise<unknown>,
  ): Promise<boolean> => {
    const key = repoKey(targetId, cwd)
    if (repo(key).operation) return false
    patch(key, { operation: name, operationError: null })
    try {
      await work()
      await get().refresh(targetId, cwd, true)
      patch(key, { operation: null })
      return true
    } catch (err) {
      patch(key, { operation: null, operationError: describeGitError(err).message })
      // 操作可能已产生部分变更；刷新失败时不覆盖操作错误。
      try {
        await get().refresh(targetId, cwd, false)
      } catch {
        // refresh 内部已吞掉错误，这里只留意图说明。
      }
      return false
    }
  }

  return {
    repos: {},

    refresh: async (targetId, cwd, includeLog = true) => {
      const key = repoKey(targetId, cwd)
      const active = refreshing.get(key)
      if (active) {
        if (includeLog) refreshWithLog.set(key, true)
        return active
      }
      refreshWithLog.set(key, includeLog)
      const task = (async () => {
        const before = repo(key)
        // 后台轻量轮询不切 loading：否则每 5s 两次无意义重渲染，刷新按钮也会一直闪转。
        const quiet = !includeLog && before.status !== null
        if (!quiet) patch(key, { loading: true })
        try {
          let status: GitStatusResult
          let branches: GitBranches | null
          if (quiet) {
            status = await serverCall(targetId, 'git.status', { cwd })
            // 分支列表只在 HEAD/分支变化时重读，轮询从 2 个请求降为 1 个。
            branches =
              before.branches && !branchesStale(before.status, status)
                ? before.branches
                : await serverCall(targetId, 'git.branches', { cwd })
          } else {
            ;[status, branches] = await Promise.all([
              serverCall(targetId, 'git.status', { cwd }),
              serverCall(targetId, 'git.branches', { cwd }),
            ])
          }
          patch(key, (prev) => {
            const next: Partial<GitRepoState> = {}
            if (!sameStatus(prev.status, status)) next.status = status
            if (!sameBranches(prev.branches, branches)) next.branches = branches
            if (prev.loading) next.loading = false
            if (prev.error !== null) next.error = null
            if (prev.errorCode !== null) next.errorCode = null
            return next
          })
        } catch (err) {
          const info = describeGitError(err)
          const stale = info.code === 'not_repo' || info.code === 'git_missing'
          patch(key, {
            loading: false,
            error: info.message,
            errorCode: info.code,
            ...(stale ? { status: null, branches: null } : {}),
          })
          return
        }
        // log 单独失败只影响历史列表，不能挡住工作区状态。
        if (!(refreshWithLog.get(key) ?? includeLog)) return
        try {
          const log = await serverCall(targetId, 'git.log', { cwd, limit: LOG_PAGE, skip: 0 })
          patch(key, (prev) => {
            const next: Partial<GitRepoState> = {}
            const merged = mergeLogFirstPage(prev.commits, log.commits)
            if (merged) {
              next.commits = merged
              next.hasMore = log.commits.length >= LOG_PAGE
            }
            if (prev.historyError !== null) next.historyError = null
            return next
          })
        } catch (err) {
          patch(key, { historyError: describeGitError(err, t('读取提交历史失败')).message })
        }
      })().finally(() => {
        refreshing.delete(key)
        refreshWithLog.delete(key)
      })
      refreshing.set(key, task)
      return task
    },

    loadMore: async (targetId, cwd) => {
      const key = repoKey(targetId, cwd)
      const current = repo(key)
      if (paging.has(key) || !current.hasMore || current.loading) return
      paging.add(key)
      patch(key, { logLoading: true })
      try {
        const result = await serverCall(targetId, 'git.log', {
          cwd,
          limit: LOG_PAGE,
          skip: current.commits.length,
        })
        patch(key, (prev) => ({
          commits: [...prev.commits, ...result.commits],
          hasMore: result.commits.length >= LOG_PAGE,
          logLoading: false,
        }))
      } catch (err) {
        patch(key, { logLoading: false, historyError: describeGitError(err, t('加载更多提交失败')).message })
      } finally {
        paging.delete(key)
      }
    },

    loadCommitFiles: async (targetId, cwd, commit) => {
      const key = repoKey(targetId, cwd)
      const cached = repo(key).commitFiles[commit]
      if (cached) return cached
      const taskKey = `${key}:${commit}`
      const active = readingFiles.get(taskKey)
      if (active) return active
      const task = (async () => {
        const result = await serverCall(targetId, 'git.commitFiles', { cwd, commit })
        patch(key, (prev) => ({ commitFiles: { ...prev.commitFiles, [commit]: result.files } }))
        return result.files
      })().finally(() => readingFiles.delete(taskKey))
      readingFiles.set(taskKey, task)
      return task
    },

    stage: (targetId, cwd, paths) =>
      run(targetId, cwd, 'stage', () => serverCall(targetId, 'git.stage', { cwd, paths })),
    unstage: (targetId, cwd, paths) =>
      run(targetId, cwd, 'unstage', () => serverCall(targetId, 'git.unstage', { cwd, paths })),
    discard: (targetId, cwd, paths, includeUntracked = false) =>
      run(targetId, cwd, 'discard', () =>
        serverCall(targetId, 'git.discard', { cwd, paths, includeUntracked }),
      ),
    commit: (targetId, cwd, message, amend = false) =>
      run(targetId, cwd, 'commit', () =>
        serverCall(targetId, 'git.commit', { cwd, message, amend }),
      ),
    switchBranch: (targetId, cwd, branch, create = false) =>
      run(targetId, cwd, 'switch', () =>
        serverCall(targetId, 'git.switch', { cwd, branch, create }),
      ),
    fetch: (targetId, cwd) =>
      run(targetId, cwd, 'fetch', () => serverCall(targetId, 'git.fetch', { cwd })),
    pull: (targetId, cwd) =>
      run(targetId, cwd, 'pull', () => serverCall(targetId, 'git.pull', { cwd })),
    push: (targetId, cwd) =>
      run(targetId, cwd, 'push', async () => {
        // 尚无 upstream 时让首个 push 同时建立跟踪关系。
        const setUpstream = !repo(repoKey(targetId, cwd)).status?.upstream
        await serverCall(targetId, 'git.push', {
          cwd,
          ...(setUpstream ? { setUpstream: true } : {}),
        })
      }),

    clearError: (targetId, cwd) => {
      patch(repoKey(targetId, cwd), {
        error: null,
        errorCode: null,
        operationError: null,
        historyError: null,
      })
    },
  }
})

/** 供对话在 turn 结束时调用；目标与 cwd 决定刷新哪个分仓。 */
export function refreshGit(targetId: string, cwd: string): Promise<void> {
  return useGit.getState().refresh(targetId, cwd)
}
