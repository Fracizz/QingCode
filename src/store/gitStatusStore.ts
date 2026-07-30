import { create } from 'zustand'
import type { GitStatus } from '@/lib/git/git'
import { isTauri } from '../lib/tauri'
import { getGitHead, getGitWorkdirStatus } from '../lib/ipc/git'
import { notifyGitDirtyCount } from '../lib/projectIndicators'
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
  /** Seed the SCM panel from the already-loaded workdir map. */
  peekPanelStatus: (projectPath: string) => GitStatus | null
  clear: () => void
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = 0
let inFlight: Promise<void> | null = null
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
      set({ refreshing: true, projectPath })
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
        const panelStatus = preserveGitStatusMetadata(
          gitStatusFromWorkdirEntries(
            projectPath,
            result.entries,
            previous?.branch ?? null,
          ),
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
