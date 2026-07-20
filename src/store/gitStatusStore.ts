import { create } from 'zustand'
import type { GitStatus } from '../lib/git'
import { isTauri, safeInvoke } from '../lib/tauri'
import {
  absoluteGitPath,
  buildStatusMap,
  dirGitStatus,
  gitStatusFromWorkdirEntries,
  gitStatusKey,
  type GitStatusEntry,
  type GitWorkdirStatus,
} from '../lib/gitStatus'
import { peekSourceControlCache, useSourceControlStore } from './sourceControlStore'

type GitStatusState = {
  projectPath: string | null
  /** Normalized absolute path → porcelain status. */
  statusByPath: Map<string, string>
  /** Original-cased dirty entries for SCM panel seeding. */
  entries: GitStatusEntry[]
  dirtyCount: number
  refreshing: boolean
  refresh: (projectPath: string | null | undefined) => Promise<void>
  /** Apply a full `git_status` snapshot without a second CLI round-trip. */
  applyFromGitStatus: (projectPath: string, status: GitStatus) => void
  scheduleRefresh: (projectPath?: string | null, delayMs?: number) => void
  statusFor: (path: string) => string | null
  statusForDir: (dirPath: string) => string | null
  /** Seed the SCM panel from the already-loaded workdir map. */
  peekPanelStatus: (projectPath: string) => GitStatus | null
  clear: () => void
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = 0
let inFlight: Promise<void> | null = null
const MIN_REFRESH_GAP_MS = 1_500

function syncSourceControlCache(projectPath: string, entries: GitStatusEntry[], isRepository: boolean) {
  const previous = peekSourceControlCache(projectPath)
  useSourceControlStore.getState().setCache(
    projectPath,
    isRepository
      ? gitStatusFromWorkdirEntries(projectPath, entries, previous?.branch ?? null)
      : { is_repository: false, branch: null, changes: [] },
  )
}

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  projectPath: null,
  statusByPath: new Map(),
  entries: [],
  dirtyCount: 0,
  refreshing: false,

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
    })
  },

  statusFor: path => get().statusByPath.get(gitStatusKey(path)) ?? null,

  statusForDir: dirPath => dirGitStatus(get().statusByPath, dirPath),

  peekPanelStatus: projectPath => {
    const state = get()
    if (state.projectPath !== projectPath) return null
    // Empty is ambiguous (clean repo vs not-yet-loaded); prefer SCM cache.
    if (state.entries.length === 0 && state.dirtyCount === 0) {
      return peekSourceControlCache(projectPath)
    }
    return gitStatusFromWorkdirEntries(
      projectPath,
      state.entries,
      peekSourceControlCache(projectPath)?.branch ?? null,
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
      })
      useSourceControlStore.getState().setCache(projectPath, status)
      lastRefreshAt = Date.now()
      return
    }
    const entries = status.changes.map(change => ({
      path: absoluteGitPath(projectPath, change.path),
      status: change.status,
    }))
    set({
      projectPath,
      statusByPath: buildStatusMap(entries),
      entries,
      dirtyCount: status.changes.length,
      refreshing: false,
    })
    useSourceControlStore.getState().setCache(projectPath, status)
    lastRefreshAt = Date.now()
  },

  refresh: async projectPath => {
    if (!projectPath || !isTauri()) {
      get().clear()
      return
    }

    const run = async () => {
      set({ refreshing: true, projectPath })
      try {
        const result = await safeInvoke<GitWorkdirStatus | null>(
          '读取 Git 状态',
          'get_git_workdir_status',
          { path: projectPath },
        )
        if (get().projectPath !== projectPath) return
        if (!result) {
          set({ statusByPath: new Map(), entries: [], dirtyCount: 0 })
          syncSourceControlCache(projectPath, [], false)
          return
        }
        set({
          statusByPath: buildStatusMap(result.entries),
          entries: result.entries,
          dirtyCount: result.dirty_count,
        })
        syncSourceControlCache(projectPath, result.entries, true)
        lastRefreshAt = Date.now()
      } catch {
        if (get().projectPath === projectPath) {
          set({ statusByPath: new Map(), entries: [], dirtyCount: 0 })
        }
      } finally {
        if (get().projectPath === projectPath) set({ refreshing: false })
      }
    }

    if (inFlight) {
      await inFlight
    }
    inFlight = run().finally(() => {
      inFlight = null
    })
    await inFlight
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
