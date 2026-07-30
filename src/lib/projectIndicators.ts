import type { EditorTab, Project, TerminalTab } from '../types'

export const PROJECT_GIT_REFRESH_MIN_MS = 60_000
export const PROJECT_GIT_REFRESH_MAX_MS = 90_000

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

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/u.test(normalized) ? normalized.toLowerCase() : normalized
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
