import type { Project, TerminalTab } from '../../types'
import type { MobileSessionSummary } from '../ipc/mobileSessions'
import type { SshDetachedTerminal } from './terminalRestorePlan'

/** 终端管理视图的来源：电脑标签、手机会话、远端未接回。 */
export type TerminalOverviewSource = 'desktop' | 'mobile' | 'remote'
export type TerminalOverviewFilter = 'all' | TerminalOverviewSource

export type TerminalOverviewEntry =
  | { source: 'desktop'; key: string; projectId: string; name: string; tab: TerminalTab }
  | { source: 'mobile'; key: string; projectId: string; name: string; session: MobileSessionSummary }
  | {
      source: 'remote'
      key: string
      projectId: string
      name: string
      connectionId: string
      terminal: SshDetachedTerminal
    }

export interface TerminalOverviewGroup {
  projectId: string
  projectName: string
  /** 手机会话所属项目已不在电脑端项目列表中。 */
  missing: boolean
  entries: TerminalOverviewEntry[]
}

export interface DetachedProjectTerminals {
  projectId: string
  connectionId: string
  terminals: SshDetachedTerminal[]
}

export interface TerminalOverviewInput {
  projects: readonly Pick<Project, 'id' | 'name'>[]
  terminals: readonly TerminalTab[]
  mobile: readonly MobileSessionSummary[]
  detached: readonly DetachedProjectTerminals[]
}

export function terminalOverviewEntries(input: TerminalOverviewInput): TerminalOverviewEntry[] {
  return [
    ...input.terminals.map(tab => ({
      source: 'desktop' as const,
      key: `desktop:${tab.id}`,
      projectId: tab.projectId,
      name: tab.name,
      tab,
    })),
    ...input.mobile.map(session => ({
      source: 'mobile' as const,
      key: `mobile:${session.id}`,
      projectId: session.project.id,
      name: session.name,
      session,
    })),
    ...input.detached.flatMap(group =>
      group.terminals.map(terminal => ({
        source: 'remote' as const,
        key: `remote:${group.connectionId}:${terminal.ptyId}`,
        projectId: group.projectId,
        name: terminal.name || terminal.ptyId,
        connectionId: group.connectionId,
        terminal,
      })),
    ),
  ]
}

export function countTerminalOverview(
  entries: readonly TerminalOverviewEntry[],
): Record<TerminalOverviewFilter, number> {
  const counts = { all: entries.length, desktop: 0, mobile: 0, remote: 0 }
  for (const entry of entries) counts[entry.source] += 1
  return counts
}

const SOURCE_ORDER: Record<TerminalOverviewSource, number> = { desktop: 0, mobile: 1, remote: 2 }

/**
 * 按项目分组：电脑端项目列表顺序在前，列表外的手机项目按名称排在后面。
 * 组内按来源（电脑 → 手机 → 远端）排列，来源内保持原顺序。
 */
export function groupTerminalOverview(
  entries: readonly TerminalOverviewEntry[],
  projects: readonly Pick<Project, 'id' | 'name'>[],
  filter: TerminalOverviewFilter = 'all',
  query = '',
): TerminalOverviewGroup[] {
  const needle = query.trim().toLowerCase()
  const known = new Map(projects.map((project, index) => [project.id, { project, index }]))
  const groups = new Map<string, TerminalOverviewGroup>()
  for (const entry of entries) {
    if (filter !== 'all' && entry.source !== filter) continue
    const projectName =
      known.get(entry.projectId)?.project.name ??
      (entry.source === 'mobile' ? entry.session.project.name : entry.projectId)
    if (needle) {
      const haystack = [entry.name, projectName, entry.source === 'mobile' ? entry.session.deviceName ?? '' : '']
        .join('\n')
        .toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    let group = groups.get(entry.projectId)
    if (!group) {
      group = { projectId: entry.projectId, projectName, missing: !known.has(entry.projectId), entries: [] }
      groups.set(entry.projectId, group)
    }
    group.entries.push(entry)
  }
  for (const group of groups.values()) {
    group.entries = group.entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => SOURCE_ORDER[a.entry.source] - SOURCE_ORDER[b.entry.source] || a.index - b.index)
      .map(item => item.entry)
  }
  return [...groups.values()].sort((a, b) => {
    const left = known.get(a.projectId)?.index ?? Number.POSITIVE_INFINITY
    const right = known.get(b.projectId)?.index ?? Number.POSITIVE_INFINITY
    return left - right || a.projectName.localeCompare(b.projectName, 'zh-CN')
  })
}

/** 「空闲 N 分钟」等，用于手机会话；不足 1 分钟返回 null。 */
export function idleMinutes(lastActiveAt: number, now: number): number | null {
  if (!lastActiveAt) return null
  const minutes = Math.floor((now - lastActiveAt) / 60_000)
  return minutes >= 1 ? minutes : null
}
