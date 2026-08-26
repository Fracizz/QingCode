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
import {
  isProjectIndicatorsEnabled,
  PROJECT_INDICATORS_EVENT,
} from '../lib/projectIndicatorSettings'
import {
  getGitRefreshIntervalStartMinutes,
  GIT_REFRESH_INTERVAL_START_EVENT,
} from '../lib/gitRefreshSettings'

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
  const [gitRefreshIntervalStartMinutes, setGitRefreshIntervalStartMinutes] = useState(
    getGitRefreshIntervalStartMinutes
  )

  useEffect(() => {
    const sync = () => setIndicatorsEnabled(isProjectIndicatorsEnabled())
    window.addEventListener(PROJECT_INDICATORS_EVENT, sync)
    return () => window.removeEventListener(PROJECT_INDICATORS_EVENT, sync)
  }, [])

  useEffect(() => {
    const sync = () => setGitRefreshIntervalStartMinutes(getGitRefreshIntervalStartMinutes())
    window.addEventListener(GIT_REFRESH_INTERVAL_START_EVENT, sync)
    queueMicrotask(sync)
    return () => window.removeEventListener(GIT_REFRESH_INTERVAL_START_EVENT, sync)
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

    const eligibleProjects = projects.filter(
      project =>
        !project.ephemeral &&
        !unavailableProjectIds.includes(project.id) &&
        (!currentProject || !projectPathsMatch(project.path, currentProject.path))
    )
    let cancelled = false
    let processing = false
    let lastFocusRefreshAt = 0
    const refreshTimers = new Map<string, number>()
    // All inactive-project Git commands share one queue to prevent concurrent polling bursts.
    const refreshQueue: Array<{ project: Project; scheduleNext: boolean }> = []
    const queuedByProject = new Map<string, { project: Project; scheduleNext: boolean }>()

    const refreshProject = async (project: Project) => {
      try {
        const status = await getGitWorkdirStatus(project.path)
        if (cancelled) return
        const dirtyCount = status?.dirty_count ?? 0
        setGitChangesByProject(previous => {
          if (previous[project.id] === dirtyCount) return previous
          return { ...previous, [project.id]: dirtyCount }
        })
      } catch {
        // Keep the previous badge when a best-effort refresh fails.
      }
    }

    const scheduleProject = (project: Project) => {
      if (cancelled || refreshTimers.has(project.id)) return
      const timer = window.setTimeout(() => {
        refreshTimers.delete(project.id)
        enqueueProject(project, true)
      }, projectGitRefreshDelay(gitRefreshIntervalStartMinutes))
      refreshTimers.set(project.id, timer)
    }

    const drainQueue = async () => {
      if (processing || cancelled) return
      processing = true
      while (!cancelled && refreshQueue.length > 0) {
        const item = refreshQueue.shift()!
        await refreshProject(item.project)
        queuedByProject.delete(item.project.id)
        if (item.scheduleNext && !cancelled) scheduleProject(item.project)
      }
      processing = false
    }

    function enqueueProject(project: Project, scheduleNext = false) {
      const existing = queuedByProject.get(project.id)
      if (existing) {
        existing.scheduleNext ||= scheduleNext
        return
      }
      const item = { project, scheduleNext }
      queuedByProject.set(project.id, item)
      refreshQueue.push(item)
      void drainQueue()
    }

    const enqueueAllIfStale = (force = false) => {
      if (!force && Date.now() - lastFocusRefreshAt < PROJECT_GIT_FOCUS_COOLDOWN_MS) return
      lastFocusRefreshAt = Date.now()
      const randomized = eligibleProjects
        .map(project => ({ project, rank: Math.random() }))
        .sort((a, b) => a.rank - b.rank)
      for (const { project } of randomized) enqueueProject(project)
    }

    for (const project of eligibleProjects) scheduleProject(project)
    const onFocus = () => enqueueAllIfStale()
    const onVisibility = () => {
      if (!document.hidden) enqueueAllIfStale()
    }
    const onWorktree = (event: Event) => {
      const path = (event as CustomEvent<{ projectPath?: string }>).detail?.projectPath
      const target = path
        ? eligibleProjects.find(project => projectPathsMatch(project.path, path))
        : undefined
      if (target) enqueueProject(target)
      else if (!path) enqueueAllIfStale(true)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('qingcode:git-worktree-changed', onWorktree)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('qingcode:git-worktree-changed', onWorktree)
      for (const timer of refreshTimers.values()) window.clearTimeout(timer)
      refreshTimers.clear()
    }
  }, [
    currentProject,
    gitRefreshIntervalStartMinutes,
    indicatorsEnabled,
    projects,
    unavailableProjectIds,
  ])

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
