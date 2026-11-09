import { isSshProject, sshConnectionIdFromUri, sshRemotePathFromUri } from '@/lib/sshWorkspace'
import { isWslProject, wslDistroNameFromPath } from '@/lib/wslWorkspace'
import type { Project, SshConnection, TerminalTab } from '../../types'

export const TERMINAL_LIST_COLLAPSED_KEY = 'qingcode:terminal-list-collapsed'

type Translate = (source: string, values?: Record<string, string | number>) => string

export interface TerminalSessionGroup {
  project: Project
  terminals: TerminalTab[]
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
    .map(project => ({
      project,
      terminals: terminals.filter(terminal => terminal.projectId === project.id),
    }))
    .filter(group => !group.project.hidden || group.terminals.length > 0)
  const pinned = groups.findIndex(group => group.project.id === pinnedProjectId)
  if (pinned > 0) groups.unshift(...groups.splice(pinned, 1))
  return groups
}

function projectSource(
  project: Project,
  connections: ReadonlyArray<SshConnection>,
  translate: Translate,
): string {
  if (isSshProject(project)) {
    const connectionId = project.connection_id || sshConnectionIdFromUri(project.path)
    const connection = connections.find(item => item.id === connectionId)
    return connection?.name || connection?.host || translate('远端')
  }
  if (isWslProject(project)) {
    const distro = wslDistroNameFromPath(project.path)
    return distro ? `WSL · ${distro}` : 'WSL'
  }
  return translate('本机')
}

function parentFolderName(project: Project): string {
  const path = isSshProject(project)
    ? project.root_path || sshRemotePathFromUri(project.path)
    : project.path
  const segments = path.split(/[/\\]+/).filter(Boolean)
  return segments[segments.length - 2] ?? ''
}

/** 组头项目名旁的来源文字；同名且同来源的项目再带上级目录名，否则仍然分不开。 */
export function terminalProjectSources(
  projects: readonly Project[],
  connections: ReadonlyArray<SshConnection>,
  translate: Translate,
): ReadonlyMap<string, string> {
  const identity = (project: Project) =>
    `${project.name}\0${projectSource(project, connections, translate)}`
  const counts = new Map<string, number>()
  for (const project of projects) {
    counts.set(identity(project), (counts.get(identity(project)) ?? 0) + 1)
  }
  return new Map(
    projects.map(project => {
      const source = projectSource(project, connections, translate)
      const parent = (counts.get(identity(project)) ?? 0) > 1 ? parentFolderName(project) : ''
      return [project.id, parent ? `${source} · ${parent}` : source]
    }),
  )
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
