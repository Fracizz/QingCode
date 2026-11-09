import type { Project, TerminalTab } from '../../types'

export const TERMINAL_LIST_COLLAPSED_KEY = 'qingcode:terminal-list-collapsed'

export interface TerminalSessionGroup {
  project: Project
  terminals: TerminalTab[]
  running: number
}

/**
 * 工作台列表的项目分组：置顶项目在最前，其余沿用项目列表的顺序。
 * 隐藏的项目没有终端时不列出；列表外的终端（项目已移除）不显示。
 */
export function groupTerminalSessions(
  projects: readonly Project[],
  terminals: readonly TerminalTab[],
  pinnedProjectId: string | null,
): TerminalSessionGroup[] {
  const groups = projects
    .map(project => {
      const owned = terminals.filter(terminal => terminal.projectId === project.id)
      return {
        project,
        terminals: owned,
        running: owned.filter(terminal => terminal.status !== 'exited').length,
      }
    })
    .filter(group => !group.project.hidden || group.terminals.length > 0)
  const pinned = groups.findIndex(group => group.project.id === pinnedProjectId)
  if (pinned > 0) groups.unshift(...groups.splice(pinned, 1))
  return groups
}

/** 解析持久化的折叠项目 id；内容损坏时视为全部展开。 */
export function parseCollapsedProjects(raw: string | null): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}
