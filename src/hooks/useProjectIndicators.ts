import { useEffect, useMemo, useState } from 'react'
import type { Project } from '../types'
import { useEditorStore } from '../store/editorStore'
import { useTerminalStore } from '../store/terminalStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { useProjectStore } from '../store/projectStore'
import { isSshResource, isTauri } from '../lib/tauri'
import {
  countDirtyTabsByProject,
  countRunningTerminalsByProject,
  projectGitRefreshDelay,
  normalizedProjectPath,
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
/** SSH 项目聚焦刷新的冷却：一次刷新 = 一次远程 git status 往返。 */
const SSH_PROJECT_GIT_FOCUS_COOLDOWN_MS = 60_000

export function useProjectIndicators(
  projects: Project[],
  unavailableProjectIds: string[]
): Record<string, ProjectIndicators> {
  const tabs = useEditorStore(state => state.tabs)
  const projectSessions = useEditorStore(state => state.projectSessions)
  const terminals = useTerminalStore(state => state.terminals)
  const currentProject = useProjectStore(state => state.currentProject)
  const snapshots = useGitStatusStore(state => state.snapshots)
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
    if (!isTauri() || !indicatorsEnabled) return

    const eligibleProjects = projects.filter(
      project =>
        !project.ephemeral &&
        !unavailableProjectIds.includes(project.id) &&
        (!currentProject || !projectPathsMatch(project.path, currentProject.path))
    )
    let cancelled = false
    let processing = false
    /** 本地项目聚焦刷新冷却。 */
    let lastFocusRefreshAt = 0
    /** SSH 项目聚焦刷新冷却（单独计时，避免和本地共用 15s 窗口）。 */
    let lastSshFocusRefreshAt = 0
    const refreshTimers = new Map<string, number>()
    // All inactive-project Git commands share one queue to prevent concurrent polling bursts.
    const refreshQueue: Array<{ project: Project; scheduleNext: boolean }> = []
    const queuedByProject = new Map<string, { project: Project; scheduleNext: boolean }>()

    const refreshProject = async (project: Project) => {
      // 窗口不可见时不打 Git：角标没人看，也避免和构建/终端抢磁盘。
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        await useGitStatusStore.getState().refresh(project.path, {
          background: true,
          reuseInFlight: true,
        })
      } catch {
        // Keep the previous badge when a best-effort refresh fails.
      }
    }

    const scheduleProject = (project: Project) => {
      if (cancelled || refreshTimers.has(project.id)) return
      const delay = projectGitRefreshDelay(
        gitRefreshIntervalStartMinutes,
        Math.random(),
        isSshResource(project.path)
      )
      const timer = window.setTimeout(() => {
        refreshTimers.delete(project.id)
        enqueueProject(project, true)
      }, delay)
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

    /**
     * 聚焦 / 重新可见时的补刷：按协议分档冷却。
     *
     * 本地项目 15 秒；SSH 项目 60 秒（一次刷新 = 一次远程往返），两者独立计时，
     * 免得多项目的 SSH 仓被 Alt-Tab 连续拉起远程 git status。
     */
    const enqueueAllIfStale = (force = false) => {
      const now = Date.now()
      const canRefreshLocal = force || now - lastFocusRefreshAt >= PROJECT_GIT_FOCUS_COOLDOWN_MS
      const canRefreshSsh = force || now - lastSshFocusRefreshAt >= SSH_PROJECT_GIT_FOCUS_COOLDOWN_MS
      if (!canRefreshLocal && !canRefreshSsh) return
      if (canRefreshLocal) lastFocusRefreshAt = now
      if (canRefreshSsh) lastSshFocusRefreshAt = now
      const randomized = eligibleProjects
        .map(project => ({ project, rank: Math.random() }))
        .sort((a, b) => a.rank - b.rank)
      for (const { project } of randomized) {
        if (isSshResource(project.path) ? canRefreshSsh : canRefreshLocal) {
          enqueueProject(project)
        }
      }
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
    return Object.fromEntries(
      projects.map(project => {
        const gitChanges = snapshots.get(normalizedProjectPath(project.path))?.dirtyCount ?? 0
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
    dirtyEditorsByProject,
    projects,
    runningByProject,
    snapshots,
  ])
}
