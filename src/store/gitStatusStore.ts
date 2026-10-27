import { hasBackend } from '../lib/runtimeCapabilities'
import { create } from 'zustand'
import type { GitStatus } from '@/lib/git/git'
import { getGitHead, getGitStatus, getGitWorkdirStatus } from '../lib/ipc/git'
import {
  notifyGitDirtyCount,
  normalizedProjectPath,
  projectPathsMatch,
} from '../lib/projectIndicators'
import {
  absoluteGitPath,
  buildStatusMap,
  dirGitStatus,
  gitStatusFromWorkdirEntries,
  preserveGitStatusMetadata,
  gitStatusKey,
  type GitStatusEntry,
} from '@/lib/git/gitStatus'

type GitSnapshot = {
  statusByPath: Map<string, string>
  entries: GitStatusEntry[]
  dirtyCount: number
  panelStatus: GitStatus
}
type RefreshOptions = {
  /** Background polling updates the cache without changing the active project. */
  background?: boolean
  /** Opening a view can reuse a pending read; file mutations need a trailing read. */
  reuseInFlight?: boolean
  full?: boolean
}
type GitStatusState = {
  projectPath: string | null
  statusByPath: Map<string, string>
  entries: GitStatusEntry[]
  dirtyCount: number
  refreshing: boolean
  panelPath: string | null
  panelStatus: GitStatus | null
  snapshots: ReadonlyMap<string, GitSnapshot>
  activate: (projectPath: string) => void
  refresh: (projectPath: string | null | undefined, options?: RefreshOptions) => Promise<void>
  applyFromGitStatus: (projectPath: string, status: GitStatus) => void
  setPanelStatus: (projectPath: string, status: GitStatus | null) => void
  clearPanelStatus: (projectPath?: string) => void
  scheduleRefresh: (projectPath?: string | null, delayMs?: number) => void
  statusFor: (path: string) => string | null
  statusForDir: (dirPath: string) => string | null
  dirtyCountFor: (projectPath?: string | null) => number
  peekPanelStatus: (projectPath: string) => GitStatus | null
  clear: () => void
}

type InFlightRefresh = { promise: Promise<void>; again: boolean; full: boolean }
const inFlight = new Map<string, InFlightRefresh>()
const revisions = new Map<string, number>()
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastRefreshAt = new Map<string, number>()
const MIN_REFRESH_GAP_MS = 1_500
const emptyActive = () => ({
  statusByPath: new Map<string, string>(),
  entries: [] as GitStatusEntry[],
  dirtyCount: 0,
  panelStatus: null,
})

export const useGitStatusStore = create<GitStatusState>((set, get) => {
  const publish = (projectPath: string, status: GitStatus) => {
    const key = normalizedProjectPath(projectPath)
    const entries = status.is_repository
      ? status.changes.map(change => ({
          path: absoluteGitPath(projectPath, change.path),
          status: change.status,
        }))
      : []
    const snapshot: GitSnapshot = {
      statusByPath: buildStatusMap(entries),
      entries,
      dirtyCount: entries.length,
      panelStatus: status,
    }
    set(state => ({
      snapshots: new Map(state.snapshots).set(key, snapshot),
      ...(state.projectPath && projectPathsMatch(state.projectPath, projectPath)
        ? { ...snapshot, panelPath: state.projectPath }
        : {}),
    }))
    lastRefreshAt.set(key, Date.now())
    notifyGitDirtyCount(projectPath, snapshot.dirtyCount)
  }

  return {
    projectPath: null,
    ...emptyActive(),
    refreshing: false,
    panelPath: null,
    snapshots: new Map(),

    activate: projectPath => {
      const key = normalizedProjectPath(projectPath)
      if (get().projectPath === projectPath) return
      const snapshot = get().snapshots.get(key)
      set({
        projectPath,
        ...(snapshot ?? emptyActive()),
        panelPath: snapshot ? projectPath : null,
        refreshing: inFlight.has(key),
      })
    },

    clear: () => {
      for (const timer of refreshTimers.values()) clearTimeout(timer)
      refreshTimers.clear()
      inFlight.clear()
      revisions.clear()
      lastRefreshAt.clear()
      set({
        projectPath: null,
        ...emptyActive(),
        refreshing: false,
        panelPath: null,
        snapshots: new Map(),
      })
    },

    setPanelStatus: (projectPath, status) => {
      if (!status) {
        get().clearPanelStatus(projectPath)
        return
      }
      if (get().peekPanelStatus(projectPath) === status) return
      if (!get().projectPath) get().activate(projectPath)
      const key = normalizedProjectPath(projectPath)
      // Filling HEAD metadata must not discard an in-flight workdir update.
      if (get().peekPanelStatus(projectPath)?.changes !== status.changes) {
        revisions.set(key, (revisions.get(key) ?? 0) + 1)
      }
      publish(projectPath, status)
    },

    clearPanelStatus: projectPath => {
      set(state => {
        const snapshots = new Map(state.snapshots)
        if (projectPath) snapshots.delete(normalizedProjectPath(projectPath))
        else snapshots.clear()
        return {
          snapshots,
          ...(!projectPath || (state.panelPath && projectPathsMatch(state.panelPath, projectPath))
            ? { panelPath: null, panelStatus: null }
            : {}),
        }
      })
    },

    statusFor: path => get().statusByPath.get(gitStatusKey(path)) ?? null,
    statusForDir: dirPath => dirGitStatus(get().statusByPath, dirPath),
    dirtyCountFor: projectPath =>
      projectPath ? (get().snapshots.get(normalizedProjectPath(projectPath))?.dirtyCount ?? 0) : 0,
    peekPanelStatus: projectPath =>
      get().snapshots.get(normalizedProjectPath(projectPath))?.panelStatus ?? null,

    applyFromGitStatus: (projectPath, status) => {
      get().activate(projectPath)
      const key = normalizedProjectPath(projectPath)
      const timer = refreshTimers.get(key)
      if (timer) clearTimeout(timer)
      refreshTimers.delete(key)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      publish(projectPath, status)
    },

    refresh: async (projectPath, options = {}) => {
      if (!projectPath || !hasBackend()) {
        if (!options.background) get().clear()
        return
      }
      const key = normalizedProjectPath(projectPath)
      if (!options.background) get().activate(projectPath)
      const existing = inFlight.get(key)
      if (existing) {
        if (!options.reuseInFlight || (options.full && !existing.full)) {
          existing.again = true
          // A file mutation (or a newer full read) makes the pending result obsolete.
          // Publish only the trailing read so badges never bounce through that old count.
          revisions.set(key, (revisions.get(key) ?? 0) + 1)
        }
        existing.full ||= options.full ?? false
        try {
          await existing.promise
        } catch (reason) {
          if (options.full) throw reason
        }
        return
      }

      const entry: InFlightRefresh = {
        promise: Promise.resolve(),
        again: false,
        full: options.full ?? false,
      }
      // Register before awaiting: a switch back to this project must join the same read.
      inFlight.set(key, entry)
      if (projectPathsMatch(get().projectPath ?? '', projectPath)) set({ refreshing: true })
      entry.promise = (async () => {
        try {
          do {
            entry.again = false
            const revision = revisions.get(key) ?? 0
            const isCurrent = () =>
              inFlight.get(key) === entry && (revisions.get(key) ?? 0) === revision
            const full = entry.full
            try {
              let status: GitStatus
              let needsHead = false
              if (full) {
                status = await getGitStatus(projectPath)
              } else {
                const result = await getGitWorkdirStatus(projectPath)
                if (!isCurrent()) continue
                needsHead = result?.branch === undefined
                const previous = get().peekPanelStatus(projectPath)
                status = result
                  ? preserveGitStatusMetadata(
                      gitStatusFromWorkdirEntries(
                        projectPath,
                        result.entries,
                        result.branch !== undefined ? result.branch : (previous?.branch ?? null)
                      ),
                      previous
                    )
                  : // The lightweight local command also returns null for transient failures
                    // (including an allowlist sync still in progress). Confirm before erasing a repo.
                    previous?.is_repository
                    ? await getGitStatus(projectPath)
                    : { is_repository: false, branch: null, changes: [] }
              }
              if (!isCurrent()) continue
              publish(projectPath, status)
              if (needsHead && status.is_repository && !status.branch) {
                try {
                  const head = await getGitHead(projectPath)
                  const latest = get().peekPanelStatus(projectPath)
                  if (isCurrent() && head?.name && latest)
                    publish(projectPath, { ...latest, branch: head.name })
                } catch {
                  /* Keep the successful workdir snapshot. */
                }
              }
            } catch (reason) {
              // Transient failures keep the last successful snapshot, including badges.
              if (full) throw reason
            }
          } while (entry.again && inFlight.get(key) === entry)
        } finally {
          if (inFlight.get(key) === entry) {
            inFlight.delete(key)
            if (projectPathsMatch(get().projectPath ?? '', projectPath)) set({ refreshing: false })
          }
        }
      })()
      try {
        await entry.promise
      } catch (reason) {
        if (options.full) throw reason
      }
    },

    scheduleRefresh: (projectPath, delayMs = 600) => {
      const path = projectPath ?? get().projectPath
      if (!path) return
      const key = normalizedProjectPath(path)
      const timer = refreshTimers.get(key)
      if (timer) clearTimeout(timer)
      const since = Date.now() - (lastRefreshAt.get(key) ?? 0)
      const wait = Math.max(delayMs, MIN_REFRESH_GAP_MS - since)
      refreshTimers.set(
        key,
        setTimeout(() => {
          refreshTimers.delete(key)
          // A delayed event from the previous project must never activate it again.
          void get().refresh(path, { background: true })
        }, wait)
      )
    },
  }
})
