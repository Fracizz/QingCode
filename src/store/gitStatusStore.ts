import { create } from 'zustand'
import type { GitStatus } from '@/lib/git/git'
import { isTauri } from '../lib/tauri'
import { getGitHead, getGitWorkdirStatus } from '../lib/ipc/git'
import { notifyGitDirtyCount, gitDirtyCountForProject } from '../lib/projectIndicators'
import {
  absoluteGitPath,
  buildStatusMap,
  dirGitStatus,
  gitStatusFromWorkdirEntries,
  preserveGitStatusMetadata,
  gitStatusKey,
  type GitStatusEntry,
  type GitWorkdirStatus,
} from '@/lib/git/gitStatus'
type GitStatusState = {
  projectPath: string | null
  /** Normalized absolute path → porcelain status. */
  statusByPath: Map<string, string>
  /** Original-cased dirty entries for SCM panel seeding. */
  entries: GitStatusEntry[]
  dirtyCount: number
  refreshing: boolean
  /** Canonical SCM snapshot for the active/recent project. */
  panelPath: string | null
  panelStatus: GitStatus | null
  refresh: (projectPath: string | null | undefined) => Promise<void>
  /** Apply a full `git_status` snapshot without a second CLI round-trip. */
  applyFromGitStatus: (projectPath: string, status: GitStatus) => void
  setPanelStatus: (projectPath: string, status: GitStatus | null) => void
  clearPanelStatus: (projectPath?: string) => void
  scheduleRefresh: (projectPath?: string | null, delayMs?: number) => void
  statusFor: (path: string) => string | null
  statusForDir: (dirPath: string) => string | null
  /** 按归属读取脏数：路径不匹配时返回 0（不串台）。 */
  dirtyCountFor: (projectPath?: string | null) => number
  /** Seed the SCM panel from the already-loaded workdir map. */
  peekPanelStatus: (projectPath: string) => GitStatus | null
  clear: () => void
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = 0
/** 在飞读取；`again` 表示读取期间又有新的刷新请求，结束后需要补读一次。 */
type InFlightRefresh = { projectPath: string; promise: Promise<void>; again: boolean }
let inFlight: InFlightRefresh | null = null
const MIN_REFRESH_GAP_MS = 1_500

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  projectPath: null,
  statusByPath: new Map(),
  entries: [],
  dirtyCount: 0,
  refreshing: false,
  panelPath: null,
  panelStatus: null,

  clear: () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    set({
      projectPath: null,
      statusByPath: new Map(),
      entries: [],
      dirtyCount: 0,
      refreshing: false,
      panelPath: null,
      panelStatus: null,
    })
  },

  setPanelStatus: (projectPath, status) =>
    set({
      panelPath: projectPath,
      panelStatus: status,
    }),

  clearPanelStatus: projectPath =>
    set(state =>
      projectPath === undefined || state.panelPath === projectPath
        ? { panelPath: null, panelStatus: null }
        : state
    ),

  statusFor: path => get().statusByPath.get(gitStatusKey(path)) ?? null,

  statusForDir: dirPath => dirGitStatus(get().statusByPath, dirPath),

  dirtyCountFor: projectPath => {
    const state = get()
    return gitDirtyCountForProject(projectPath, state.projectPath, state.dirtyCount)
  },

  peekPanelStatus: projectPath => {
    const state = get()
    if (state.panelPath === projectPath && state.panelStatus) return state.panelStatus
    if (state.projectPath !== projectPath) return null
    return preserveGitStatusMetadata(
      gitStatusFromWorkdirEntries(
        projectPath,
        state.entries,
        state.panelPath === projectPath ? (state.panelStatus?.branch ?? null) : null,
      ),
      state.panelPath === projectPath ? state.panelStatus : null,
    )
  },

  applyFromGitStatus: (projectPath, status) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (!status.is_repository) {
      set({
        projectPath,
        statusByPath: new Map(),
        entries: [],
        dirtyCount: 0,
        refreshing: false,
        panelPath: projectPath,
        panelStatus: status,
      })
      notifyGitDirtyCount(projectPath, 0)
      lastRefreshAt = Date.now()
      return
    }
    const entries = status.changes.map(change => ({
      path: absoluteGitPath(projectPath, change.path),
      status: change.status,
    }))
    const dirtyCount = status.changes.length
    set({
      projectPath,
      statusByPath: buildStatusMap(entries),
      entries,
      dirtyCount,
      refreshing: false,
      panelPath: projectPath,
      panelStatus: status,
    })
    notifyGitDirtyCount(projectPath, dirtyCount)
    lastRefreshAt = Date.now()
  },

  refresh: async projectPath => {
    if (!projectPath || !isTauri()) {
      get().clear()
      return
    }

    const run = async () => {
      if (get().projectPath !== projectPath) {
        // 换了项目：先清空派生状态再读取，避免把上一个项目的数字当成新项目的。
        set({
          projectPath,
          statusByPath: new Map(),
          entries: [],
          dirtyCount: 0,
          refreshing: true,
          panelPath: null,
          panelStatus: null,
        })
      } else {
        set({ refreshing: true, projectPath })
      }
      try {
        const result: GitWorkdirStatus | null = await getGitWorkdirStatus(projectPath)
        if (get().projectPath !== projectPath) return
        if (!result) {
          set({
            statusByPath: new Map(),
            entries: [],
            dirtyCount: 0,
            panelPath: projectPath,
            panelStatus: { is_repository: false, branch: null, changes: [] },
          })
          notifyGitDirtyCount(projectPath, 0)
          return
        }
        const previous = get().panelPath === projectPath ? get().panelStatus : null
        // SSH 的 workdir 快照自带分支名；本地命令没有时沿用上一次快照。
        const branch =
          result.branch !== undefined ? result.branch : (previous?.branch ?? null)
        const panelStatus = preserveGitStatusMetadata(
          gitStatusFromWorkdirEntries(projectPath, result.entries, branch),
          previous,
        )
        set({
          statusByPath: buildStatusMap(result.entries),
          entries: result.entries,
          dirtyCount: result.dirty_count,
          panelPath: projectPath,
          panelStatus,
        })
        notifyGitDirtyCount(projectPath, result.dirty_count)
        // Workdir status confirms a repo but does not include the branch name.
        // Fill HEAD so the status bar / SCM soft-open can show it without a
        // second full `git_status` round-trip.
        if (panelStatus.is_repository && !panelStatus.branch) {
          try {
            const head = await getGitHead(projectPath)
            if (get().projectPath !== projectPath) return
            if (head?.name) {
              set(state => ({
                panelStatus:
                  state.panelPath === projectPath && state.panelStatus
                    ? { ...state.panelStatus, branch: head.name }
                    : state.panelStatus,
              }))
            }
          } catch {
            /* keep null branch */
          }
        }
        lastRefreshAt = Date.now()
      } catch {
        // Keep the previous badge on transient CLI failures (same as project-tab indicators).
      } finally {
        if (get().projectPath === projectPath) set({ refreshing: false })
      }
    }

    // 同一项目的并发调用合并：在飞读取可能早于这次调用之前的改动（例如刚保存），
    // 直接复用它的结果会丢更新；因此只记一次补读，读完后再跑一轮。
    // 期间再来多少次调用都只补读一次，同一仓库也不会并发跑两条 git status。
    if (inFlight?.projectPath === projectPath) {
      inFlight.again = true
      return inFlight.promise
    }

    const entry: InFlightRefresh = { projectPath, again: false, promise: Promise.resolve() }
    entry.promise = (async () => {
      try {
        do {
          entry.again = false
          await run()
        } while (entry.again && get().projectPath === projectPath)
      } finally {
        if (inFlight === entry) inFlight = null
      }
    })()
    inFlight = entry
    await entry.promise
  },

  scheduleRefresh: (projectPath, delayMs = 600) => {
    const path = projectPath ?? get().projectPath
    if (!path) return
    if (refreshTimer) clearTimeout(refreshTimer)
    const since = Date.now() - lastRefreshAt
    const wait = Math.max(delayMs, since < MIN_REFRESH_GAP_MS ? MIN_REFRESH_GAP_MS - since : 0)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void get().refresh(path)
    }, wait)
  },
}))
