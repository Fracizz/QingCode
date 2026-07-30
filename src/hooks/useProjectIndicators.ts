import { useEffect, useMemo, useState } from 'react'
import type { Project } from '../types'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { useProjectStore } from '../store/projectStore'
import { getGitWorkdirStatus } from '../lib/ipc/git'
import { isTauri } from '../lib/tauri'
import {
  countDirtyTabsByProject,
  countRunningTerminalsByProject,
  GIT_DIRTY_COUNT_EVENT,
  type GitDirtyCountDetail,
  projectGitRefreshDelay,
  projectPathsMatch,
} from '../lib/projectIndicators'
import { isProjectIndicatorsEnabled, PROJECT_INDICATORS_EVENT } from '../lib/projectIndicatorSettings'

export type ProjectIndicators = {
  running: number
  dirtyEditors: number
  gitChanges: number
}

export const EMPTY_PROJECT_INDICATORS: ProjectIndicators = {
  running: 0,
  dirtyEditors: 0,
  gitChanges: 0,
}

const PROJECT_GIT_CONCURRENCY = 2
const PROJECT_GIT_FOCUS_COOLDOWN_MS = 15_000

export function useProjectIndicators(
  projects: Project[],
  unavailableProjectIds: string[]
): Record<string, ProjectIndicators> {
  const tabs = useEditorStore(state => state.tabs)
  const projectSessions = useEditorStore(state => state.projectSessions)
  const terminals = useTerminalStore(state => state.terminals)
  const currentProject = useProjectStore(state => state.currentProject)
  const storeProjectPath = useGitStatusStore(state => state.projectPath)
  const storeDirtyCount = useGitStatusStore(state => state.dirtyCount)
  const [gitChangesByProject, setGitChangesByProject] = useState<Record<string, number>>({})
  const [indicatorsEnabled, setIndicatorsEnabled] = useState(isProjectIndicatorsEnabled)

  useEffect(() => {
    const sync = () => setIndicatorsEnabled(isProjectIndicatorsEnabled())
    window.addEventListener(PROJECT_INDICATORS_EVENT, sync)
    return () => window.removeEventListener(PROJECT_INDICATORS_EVENT, sync)
  }, [])

  const runningByProject = useMemo(() => countRunningTerminalsByProject(terminals), [terminals])
  const dirtyEditorsByProject = useMemo(
    () => countDirtyTabsByProject(projects, tabs, projectSessions),
    [projectSessions, projects, tabs]
  )

  useEffect(() => {
    if (!indicatorsEnabled) return

    const onDirtyCount = (event: Event) => {
      const detail = (event as CustomEvent<GitDirtyCountDetail>).detail
      if (!detail?.projectPath) return
      const project = projects.find(p => projectPathsMatch(p.path, detail.projectPath))
      if (!project || unavailableProjectIds.includes(project.id)) return
      setGitChangesByProject(previous => {
        if (previous[project.id] === detail.dirtyCount) return previous
        return { ...previous, [project.id]: detail.dirtyCount }
      })
    }

    window.addEventListener(GIT_DIRTY_COUNT_EVENT, onDirtyCount)
    return () => window.removeEventListener(GIT_DIRTY_COUNT_EVENT, onDirtyCount)
  }, [indicatorsEnabled, projects, unavailableProjectIds])

  useEffect(() => {
    if (!isTauri() || !indicatorsEnabled) {
      queueMicrotask(() => setGitChangesByProject({}))
      return
    }

    let cancelled = false
    let generation = 0
    let lastFullRefreshAt = 0
    let refreshTimer: number | null = null

    const refresh = async (targets: Project[] = projects) => {
      const refreshGeneration = ++generation
      let cursor = 0
      const next: Record<string, number> = {}
      const workers = Array.from(
        { length: Math.min(PROJECT_GIT_CONCURRENCY, targets.length) },
        async () => {
          while (cursor < targets.length) {
            const project = targets[cursor++]
            if (!project || project.ephemeral || unavailableProjectIds.includes(project.id)) {
              continue
            }
            try {
              const status = await getGitWorkdirStatus(project.path)
              next[project.id] = status?.dirty_count ?? 0
            } catch {
              // Keep the previous badge when a best-effort refresh fails.
            }
          }
        }
      )
      await Promise.all(workers)
      if (cancelled || refreshGeneration !== generation) return
      setGitChangesByProject(previous => {
        const merged = { ...previous }
        const currentIds = new Set(projects.map(project => project.id))
        for (const id of Object.keys(merged)) {
          if (!currentIds.has(id)) delete merged[id]
        }
        for (const project of targets) {
          if (Object.prototype.hasOwnProperty.call(next, project.id)) {
            merged[project.id] = next[project.id]
          }
        }
        return merged
      })

      // If the background poll disagrees with the activity-bar store, refresh the store.
      const store = useGitStatusStore.getState()
      if (!store.projectPath || store.refreshing) return
      const tracked = targets.find(project => projectPathsMatch(project.path, store.projectPath!))
      if (!tracked || !Object.prototype.hasOwnProperty.call(next, tracked.id)) return
      if (next[tracked.id] !== store.dirtyCount) {
        store.scheduleRefresh(store.projectPath, 200)
      }
    }

    const refreshAllIfStale = async (force = false) => {
      if (!force && Date.now() - lastFullRefreshAt < PROJECT_GIT_FOCUS_COOLDOWN_MS) return
      lastFullRefreshAt = Date.now()
      await refresh()
    }
    const scheduleRefresh = () => {
      refreshTimer = window.setTimeout(async () => {
        await refreshAllIfStale()
        if (!cancelled) scheduleRefresh()
      }, projectGitRefreshDelay())
    }

    void refreshAllIfStale(true)
    scheduleRefresh()
    const onFocus = () => void refreshAllIfStale()
    const onVisibility = () => {
      if (!document.hidden) void refreshAllIfStale()
    }
    const onWorktree = (event: Event) => {
      const path = (event as CustomEvent<{ projectPath?: string }>).detail?.projectPath
      const target = path
        ? projects.find(project => projectPathsMatch(project.path, path))
        : undefined
      void refresh(target ? [target] : projects)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('qingcode:git-worktree-changed', onWorktree)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('qingcode:git-worktree-changed', onWorktree)
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [indicatorsEnabled, projects, unavailableProjectIds])

  return useMemo(() => {
    const useStoreForCurrent =
      !!currentProject &&
      !!storeProjectPath &&
      projectPathsMatch(currentProject.path, storeProjectPath)

    return Object.fromEntries(
      projects.map(project => {
        const fromCache = gitChangesByProject[project.id] ?? 0
        const gitChanges =
          useStoreForCurrent && project.id === currentProject.id ? storeDirtyCount : fromCache
        return [
          project.id,
          {
            running: runningByProject[project.id] ?? 0,
            dirtyEditors: dirtyEditorsByProject[project.id] ?? 0,
            gitChanges,
          },
        ]
      })
    )
  }, [
    currentProject,
    dirtyEditorsByProject,
    gitChangesByProject,
    projects,
    runningByProject,
    storeDirtyCount,
    storeProjectPath,
  ])
}
