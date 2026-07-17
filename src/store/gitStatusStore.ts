import { create } from 'zustand'
import { isTauri, safeInvoke } from '../lib/tauri'
import {
  buildStatusMap,
  dirGitStatus,
  gitStatusKey,
  type GitWorkdirStatus,
} from '../lib/gitStatus'

type GitStatusState = {
  projectPath: string | null
  /** Normalized absolute path → porcelain status. */
  statusByPath: Map<string, string>
  dirtyCount: number
  refreshing: boolean
  refresh: (projectPath: string | null | undefined) => Promise<void>
  scheduleRefresh: (projectPath?: string | null, delayMs?: number) => void
  statusFor: (path: string) => string | null
  statusForDir: (dirPath: string) => string | null
  clear: () => void
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let lastRefreshAt = 0
let inFlight: Promise<void> | null = null
const MIN_REFRESH_GAP_MS = 1_500

export const useGitStatusStore = create<GitStatusState>((set, get) => ({
  projectPath: null,
  statusByPath: new Map(),
  dirtyCount: 0,
  refreshing: false,

  clear: () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    set({ projectPath: null, statusByPath: new Map(), dirtyCount: 0, refreshing: false })
  },

  statusFor: path => get().statusByPath.get(gitStatusKey(path)) ?? null,

  statusForDir: dirPath => dirGitStatus(get().statusByPath, dirPath),

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
          set({ statusByPath: new Map(), dirtyCount: 0 })
          return
        }
        set({
          statusByPath: buildStatusMap(result.entries),
          dirtyCount: result.dirty_count,
        })
        lastRefreshAt = Date.now()
      } catch {
        if (get().projectPath === projectPath) {
          set({ statusByPath: new Map(), dirtyCount: 0 })
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
