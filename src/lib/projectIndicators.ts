import type { EditorTab, Project, TerminalTab } from '../types'

export const PROJECT_GIT_REFRESH_MIN_MS = 60_000
export const PROJECT_GIT_REFRESH_MAX_MS = 90_000

/** Fired when the active-project Git dirty count is known (SCM store / workdir refresh). */
export const GIT_DIRTY_COUNT_EVENT = 'qingcode:git-dirty-count'

export type GitDirtyCountDetail = {
  projectPath: string
  dirtyCount: number
}

type ProjectEditorSessionLike = {
  tabs: EditorTab[]
}

export function projectGitRefreshDelay(randomValue = Math.random()): number {
  const normalized = Math.max(0, Math.min(1, randomValue))
  return Math.round(
    PROJECT_GIT_REFRESH_MIN_MS +
      normalized * (PROJECT_GIT_REFRESH_MAX_MS - PROJECT_GIT_REFRESH_MIN_MS)
  )
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
