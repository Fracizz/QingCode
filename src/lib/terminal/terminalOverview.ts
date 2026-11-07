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

/**
 * 程序标题开头的转圈帧字符：盲文点阵（含空白帧）与圆形/方块转圈。
 * 须与后端 `is_spinner_glyph`（src-tauri/src/mobile.rs）和手机端 protocol.js 保持一致。
 */
const SPINNER_PREFIX = /^[\u2800-\u28ff\u25d0-\u25d3\u25e2-\u25e5\u25f0-\u25f7]\s*/u

/**
 * 手机会话的显示名：只去掉程序标题开头的转圈帧字符（由平滑的转圈图标代替），
 * 其余原样保留（如 `✳ Claude Code`）；手动设置的名称不做任何处理。
 */
export function mobileSessionDisplayName(session: Pick<MobileSessionSummary, 'name' | 'customName'>): string {
  if (session.customName) return session.name
  return session.name.replace(SPINNER_PREFIX, '') || session.name
}

export function terminalOverviewEntries(input: TerminalOverviewInput): TerminalOverviewEntry[] {
  const attached = new Set(input.terminals.filter(tab => tab.ptyId).map(tab => `${tab.connectionId ?? ''}:${tab.ptyId}`))
  const remoteKeys = new Set<string>()
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
      name: mobileSessionDisplayName(session),
      session,
    })),
    ...input.detached.flatMap(group =>
      group.terminals.filter(terminal => {
        const key = `${group.connectionId}:${terminal.ptyId}`
        if (attached.has(key) || attached.has(`:${terminal.ptyId}`) || remoteKeys.has(key)) return false
        remoteKeys.add(key)
        return true
      }).map(terminal => ({
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
 * 组内运行中（程序正在工作）的排最前，再按来源（电脑 → 手机 → 远端），来源内保持原顺序。
 */
export function groupTerminalOverview(
  entries: readonly TerminalOverviewEntry[],
  projects: readonly Pick<Project, 'id' | 'name'>[],
  filter: TerminalOverviewFilter = 'all',
  query = '',
  /** 额外的可搜索文本（如已翻译的状态、来源标签），由视图层提供。 */
  describe?: (entry: TerminalOverviewEntry) => readonly string[],
  /** 程序是否正在工作；运行中的终端在组内排在最前，彼此保持来源与原顺序。 */
  running?: (entry: TerminalOverviewEntry) => boolean,
): TerminalOverviewGroup[] {
  // 空白分隔的多个关键词需全部命中，不区分大小写与顺序。
  const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const known = new Map(projects.map((project, index) => [project.id, { project, index }]))
  const groups = new Map<string, TerminalOverviewGroup>()
  for (const entry of entries) {
    if (filter !== 'all' && entry.source !== filter) continue
    const projectName =
      known.get(entry.projectId)?.project.name ??
      (entry.source === 'mobile' ? entry.session.project.name : entry.projectId)
    if (needles.length) {
      const haystack = [
        entry.name,
        projectName,
        entry.source === 'mobile' ? entry.session.deviceName ?? '' : '',
        ...(describe?.(entry) ?? []),
      ]
        .join('\n')
        .toLowerCase()
      if (!needles.every(needle => haystack.includes(needle))) continue
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
      .map((entry, index) => ({ entry, index, running: running?.(entry) === true }))
      .sort((a, b) =>
        Number(b.running) - Number(a.running)
        || SOURCE_ORDER[a.entry.source] - SOURCE_ORDER[b.entry.source]
        || a.index - b.index)
      .map(item => item.entry)
  }
  return [...groups.values()].sort((a, b) => {
    const left = known.get(a.projectId)?.index ?? Number.POSITIVE_INFINITY
    const right = known.get(b.projectId)?.index ?? Number.POSITIVE_INFINITY
    return left - right || a.projectName.localeCompare(b.projectName, 'zh-CN')
  })
}

export interface TerminalOverviewPagedGroup extends TerminalOverviewGroup {
  /** 该项目在全部筛选结果中的终端数（本页可能只显示其中一部分）。 */
  total: number
}

export interface TerminalOverviewPage {
  groups: TerminalOverviewPagedGroup[]
  /** 已夹取到合法范围内的页码（从 0 开始）。 */
  page: number
  pageCount: number
  total: number
}

/**
 * 按终端条数分页（而不是按项目组），保持分组顺序；跨页的项目组在每一页都会带上组头。
 * 页码越界时夹取到最后一页，便于批量关闭后列表变短时不出现空页。
 */
export function paginateTerminalOverview(
  groups: readonly TerminalOverviewGroup[],
  page: number,
  pageSize: number,
): TerminalOverviewPage {
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0)
  const pageCount = Math.max(1, Math.ceil(total / size))
  const safePage = Math.min(Math.max(0, Math.floor(page) || 0), pageCount - 1)
  const start = safePage * size
  const end = start + size
  const paged: TerminalOverviewPagedGroup[] = []
  let offset = 0
  for (const group of groups) {
    const groupStart = offset
    offset += group.entries.length
    if (offset <= start || groupStart >= end) continue
    paged.push({
      ...group,
      total: group.entries.length,
      entries: group.entries.slice(Math.max(0, start - groupStart), end - groupStart),
    })
  }
  return { groups: paged, page: safePage, pageCount, total }
}

/**
 * 终端里的程序是否正在工作（标题在转圈），与手机端「运行中」一致。
 * desktopBusy 由视图层根据原始标题判断；远端未接回的终端无法得知，视为否。
 */
export function isTerminalOverviewEntryRunning(
  entry: TerminalOverviewEntry,
  desktopBusy: (tab: TerminalTab) => boolean,
): boolean {
  if (entry.source === 'desktop') return entry.tab.status !== 'exited' && desktopBusy(entry.tab)
  if (entry.source === 'mobile') return !entry.session.exit && entry.session.programBusy
  return false
}

/** 终端是否已退出/结束（关闭它不会结束任何正在运行的程序）。远端未接回的终端总在运行。 */
export function isTerminalOverviewEntryExited(entry: TerminalOverviewEntry): boolean {
  if (entry.source === 'desktop') return entry.tab.status === 'exited'
  if (entry.source === 'mobile') return entry.session.exit !== null
  return false
}

/** 批量关闭前的统计：总数与仍在运行的数量（用于确认文案）。 */
export function summarizeTerminalOverviewBatch(entries: readonly TerminalOverviewEntry[]) {
  let running = 0
  for (const entry of entries) if (!isTerminalOverviewEntryExited(entry)) running += 1
  return { total: entries.length, running, exited: entries.length - running }
}

/**
 * 创建时间的短文本：当天「HH:mm」，同年「MM-DD HH:mm」，跨年带年份；无效时间返回 null。
 * 手机端 protocol.js 的 createdLabel 使用相同格式。
 */
export function formatCreatedTime(createdAt: number | null | undefined, now: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return null
  const date = new Date(createdAt)
  const today = new Date(now)
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  if (date.toDateString() === today.toDateString()) return time
  return date.getFullYear() === today.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`
}

/** 「空闲 N 分钟」等，用于手机会话；不足 1 分钟返回 null。 */
export function idleMinutes(lastActiveAt: number, now: number): number | null {
  if (!lastActiveAt) return null
  const minutes = Math.floor((now - lastActiveAt) / 60_000)
  return minutes >= 1 ? minutes : null
}
