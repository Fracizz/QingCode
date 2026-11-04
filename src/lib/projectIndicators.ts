import type { EditorTab, Project, TerminalTab } from '../types'
import {
  DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES,
  parseGitRefreshIntervalStartMinutes,
} from './gitRefreshSettings'

/** Fired when the active-project Git dirty count is known (SCM store / workdir refresh). */
export const GIT_DIRTY_COUNT_EVENT = 'qingcode:git-dirty-count'

export type GitDirtyCountDetail = {
  projectPath: string
  dirtyCount: number
}

type ProjectEditorSessionLike = {
  tabs: EditorTab[]
}

/**
 * SSH 项目后台角标的轮询倍率。
 *
 * 本地一次刷新是一个 `git status` 子进程；SSH 一次刷新是一次远程往返 + 远端全量
 * `git status`，代价高一个数量级，因此拉长周期而不是与本地同频。
 */
export const SSH_PROJECT_GIT_REFRESH_MULTIPLIER = 4

export function projectGitRefreshDelay(
  intervalStartMinutes = DEFAULT_GIT_REFRESH_INTERVAL_START_MINUTES,
  randomValue = Math.random(),
  isSshProject = false
): number {
  const startMinutes = parseGitRefreshIntervalStartMinutes(intervalStartMinutes)
  const spreadMinutes = Math.max(1, Math.ceil(startMinutes / 2))
  const normalizedRandom = Math.max(0, Math.min(1, randomValue))
  const randomOffsetMinutes = Math.min(
    spreadMinutes,
    Math.floor(normalizedRandom * (spreadMinutes + 1))
  )
  const scale = isSshProject ? SSH_PROJECT_GIT_REFRESH_MULTIPLIER : 1
  return (startMinutes + randomOffsetMinutes) * 60_000 * scale
}

export function normalizedProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/u.test(normalized) ? normalized.toLowerCase() : normalized
}

function normalizedPath(path: string): string {
  return normalizedProjectPath(path)
}

export function projectPathsMatch(a: string, b: string): boolean {
  return normalizedProjectPath(a) === normalizedProjectPath(b)
}

/**
 * Git 更改数归属：状态库还停留在别的项目时返回 0。
 *
 * 切项目会立刻发起一次 Git 读取，但快照返回前 `dirtyCount` 仍是上一个项目的数字；
 * 直接读它会把这个数字挂到新项目上（页面徽标 / 活动栏 / 状态栏都会跳一下）。
 */
export function gitDirtyCountForProject(
  projectPath: string | null | undefined,
  storeProjectPath: string | null | undefined,
  storeDirtyCount: number
): number {
  if (!projectPath || !storeProjectPath) return 0
  return projectPathsMatch(projectPath, storeProjectPath) ? storeDirtyCount : 0
}

/** Keep project-tab Git badges in lockstep with the activity-bar SCM badge. */
export function notifyGitDirtyCount(projectPath: string, dirtyCount: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<GitDirtyCountDetail>(GIT_DIRTY_COUNT_EVENT, {
      detail: { projectPath, dirtyCount },
    })
  )
}

function owningProjectId(projects: Project[], path: string): string | null {
  const target = normalizedPath(path)
  let owner: Project | null = null
  for (const project of projects) {
    const root = normalizedPath(project.path)
    if (target !== root && !target.startsWith(`${root}/`)) continue
    if (!owner || root.length > normalizedPath(owner.path).length) owner = project
  }
  return owner?.id ?? null
}

export function countDirtyTabsByProject(
  projects: Project[],
  activeTabs: EditorTab[],
  projectSessions: Record<string, ProjectEditorSessionLike>
): Record<string, number> {
  const counts: Record<string, number> = {}
  const seen = new Set<string>()
  const tabs = [...activeTabs, ...Object.values(projectSessions).flatMap(session => session.tabs)]

  for (const tab of tabs) {
    if (!tab.dirty || tab.kind === 'diff') continue
    const key = `${tab.id}\0${normalizedPath(tab.path)}`
    if (seen.has(key)) continue
    seen.add(key)
    const projectId = owningProjectId(projects, tab.path)
    if (projectId) counts[projectId] = (counts[projectId] ?? 0) + 1
  }
  return counts
}

export function countRunningTerminalsByProject(
  terminals: Array<Pick<TerminalTab, 'projectId' | 'status'>>
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const terminal of terminals) {
    if (terminal.status === 'exited') continue
    counts[terminal.projectId] = (counts[terminal.projectId] ?? 0) + 1
  }
  return counts
}
