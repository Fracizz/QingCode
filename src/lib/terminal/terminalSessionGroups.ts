import { insertIndexToReorderTarget, sortVisibleProjects } from '@/lib/projectChipOrder'
import { isSshProject, sshConnectionIdFromUri, sshRemotePathFromUri } from '@/lib/sshWorkspace'
import { isWslProject, wslDistroNameFromPath } from '@/lib/wslWorkspace'
import { formatTerminalName } from '@/utils/terminalName'
import type { Project, SshConnection, TerminalTab } from '../../types'

export const TERMINAL_LIST_COLLAPSED_KEY = 'qingcode:terminal-list-collapsed'

type Translate = (source: string, values?: Record<string, string | number>) => string

export interface TerminalSessionGroup {
  project: Project
  terminals: TerminalTab[]
}

/**
 * 工作台列表的项目分组：顺序与顶部项目标签一致，隐藏项目排在最后。
 * 隐藏的项目没有终端时不列出；列表外的终端（项目已移除）不显示。
 */
export function groupTerminalSessions(
  projects: readonly Project[],
  terminals: readonly TerminalTab[],
): TerminalSessionGroup[] {
  return [...sortVisibleProjects([...projects]), ...projects.filter(project => project.hidden)]
    .map(project => ({
      project,
      terminals: terminals.filter(terminal => terminal.projectId === project.id),
    }))
    .filter(group => !group.project.hidden || group.terminals.length > 0)
}

/**
 * 来源筛选：`all` 全部、`local` 仅本机、`remote` 全部远程（SSH + WSL，与组头云朵图标一致），
 * 其余为具体来源键（`ssh:<连接 id>` / `wsl:<发行版>`）。
 */
export type TerminalScopeFilter = string

export interface TerminalScopeOption {
  key: string
  label: string
  count: number
}

/** 项目所属来源键：本机固定为 `local`，远程按连接 / 发行版区分。 */
export function terminalProjectScopeKey(project: Project): string {
  if (isSshProject(project)) {
    return `ssh:${project.connection_id || sshConnectionIdFromUri(project.path)}`
  }
  if (isWslProject(project)) return `wsl:${(wslDistroNameFromPath(project.path) ?? '').toLowerCase()}`
  return 'local'
}

export function terminalScopeMatches(project: Project, filter: TerminalScopeFilter): boolean {
  if (filter === 'all') return true
  const key = terminalProjectScopeKey(project)
  if (filter === 'local') return key === 'local'
  if (filter === 'remote') return key !== 'local'
  return key === filter
}

/** 筛选菜单里的具体远程来源（按出现顺序），带各来源的终端数。 */
export function terminalRemoteScopeOptions(
  groups: readonly TerminalSessionGroup[],
  connections: ReadonlyArray<SshConnection>,
  translate: Translate,
): TerminalScopeOption[] {
  const options = new Map<string, TerminalScopeOption>()
  for (const { project, terminals } of groups) {
    const key = terminalProjectScopeKey(project)
    if (key === 'local') continue
    const existing = options.get(key)
    if (existing) existing.count += terminals.length
    else {
      options.set(key, {
        key,
        label: projectSource(project, connections, translate),
        count: terminals.length,
      })
    }
  }
  return [...options.values()]
}

/**
 * 列表的搜索、来源筛选与「运行中优先」，只影响显示。关键词按空白分隔、全部命中才保留，
 * 匹配终端名、项目名和来源；搜索时没有结果的项目组不列出。运行中的排在组内最前，彼此保持原顺序。
 */
export function filterTerminalSessionGroups(
  groups: readonly TerminalSessionGroup[],
  {
    query,
    sources,
    running,
    scope = 'all',
  }: {
    query: string
    sources: ReadonlyMap<string, string>
    running?: (terminal: TerminalTab) => boolean
    scope?: TerminalScopeFilter
  },
): TerminalSessionGroup[] {
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return groups.flatMap(group => {
    if (!terminalScopeMatches(group.project, scope)) return []
    let terminals = group.terminals
    if (needles.length > 0) {
      const context = [group.project.name, sources.get(group.project.id) ?? '']
      terminals = terminals.filter(terminal => {
        const haystack = [formatTerminalName(terminal.name), ...context].join('\n').toLowerCase()
        return needles.every(needle => haystack.includes(needle))
      })
      if (terminals.length === 0) return []
    }
    if (running) {
      terminals = [...terminals].sort((a, b) => Number(running(b)) - Number(running(a)))
    }
    return [{ project: group.project, terminals }]
  })
}

/**
 * 把项目组拖到目标组前或后，换算成 `reorderVisibleProjects` 的下标。
 * 隐藏项目不参与排序；位置没有变化时返回 null。
 */
export function terminalProjectMove(
  projects: readonly Project[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): { fromIndex: number; toIndex: number } | null {
  const visible = sortVisibleProjects([...projects])
  const fromIndex = visible.findIndex(project => project.id === sourceId)
  const targetIndex = visible.findIndex(project => project.id === targetId)
  if (fromIndex < 0 || targetIndex < 0 || sourceId === targetId) return null
  const toIndex = insertIndexToReorderTarget(
    fromIndex,
    position === 'before' ? targetIndex : targetIndex + 1,
  )
  return toIndex === fromIndex ? null : { fromIndex, toIndex }
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
