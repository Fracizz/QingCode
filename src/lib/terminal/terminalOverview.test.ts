import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../types'
import type { MobileSessionSummary } from '../ipc/mobileSessions'
import { parseMobileSessionSummary } from '../ipc/mobileSessions'
import {
  countTerminalOverview,
  formatCompactCreatedTime,
  formatCreatedTime,
  formatFullCreatedTime,
  groupTerminalOverview,
  idleMinutes,
  isTerminalOverviewEntryExited,
  isTerminalOverviewEntryRunning,
  mobileSessionDisplayName,
  paginateTerminalOverview,
  summarizeTerminalOverviewBatch,
  terminalOverviewEntries,
  type TerminalOverviewGroup,
} from './terminalOverview'

const projects = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
]

function tab(id: string, projectId: string, name = id): TerminalTab {
  return { id, name, projectId, cwd: 'C:\\p', launchCommand: '', status: 'running', exitCode: null } as TerminalTab
}

function mobile(id: string, projectId: string, projectName = projectId, deviceName: string | null = 'Pixel'): MobileSessionSummary {
  return {
    id,
    number: 1,
    name: `phone ${id}`,
    customName: null,
    programBusy: false,
    exit: null,
    lastActiveAt: 0,
    createdAt: null,
    idleDeadline: null,
    project: { id: projectId, name: projectName, path: '', kind: 'local', host: 'Windows' },
    deviceName,
  }
}

describe('terminal overview', () => {
  const entries = terminalOverviewEntries({
    projects,
    terminals: [tab('t2', 'b'), tab('t1', 'a')],
    mobile: [mobile('mobile-1', 'a'), mobile('mobile-9', 'gone', 'Old project')],
    detached: [
      {
        projectId: 'b',
        connectionId: 'c',
        terminals: [{ ptyId: 'pty-1', connectionId: 'c', cwd: 'ssh://c/srv', cols: 80, rows: 24 }],
      },
    ],
  })

  it('counts every source across projects', () => {
    expect(countTerminalOverview(entries)).toEqual({ all: 5, desktop: 2, mobile: 2, remote: 1 })
  })

  it('excludes reattached remote terminals and deduplicates stale project responses by connection', () => {
    const attached = { ...tab('attached', 'a'), ptyId: 'pty-1', connectionId: 'c' }
    const group = {
      projectId: 'b', connectionId: 'c',
      terminals: [{ ptyId: 'pty-1', connectionId: 'c', cwd: 'ssh://c/srv', cols: 80, rows: 24 }],
    }
    expect(terminalOverviewEntries({ projects, terminals: [attached], mobile: [], detached: [group] })
      .map(entry => entry.key)).toEqual(['desktop:attached'])
    expect(terminalOverviewEntries({ projects, terminals: [], mobile: [], detached: [group, group] })
      .map(entry => entry.key)).toEqual(['remote:c:pty-1'])
    expect(terminalOverviewEntries({ projects, terminals: [{ ...attached, connectionId: 'other' }], mobile: [], detached: [group] })
      .map(entry => entry.key)).toEqual(['desktop:attached', 'remote:c:pty-1'])
  })

  it('groups by project list order with unknown mobile projects last, desktop before mobile before remote', () => {
    const groups = groupTerminalOverview(entries, projects)
    expect(groups.map(group => [group.projectName, group.missing])).toEqual([
      ['Alpha', false],
      ['Beta', false],
      ['Old project', true],
    ])
    expect(groups[0].entries.map(entry => entry.source)).toEqual(['desktop', 'mobile'])
    expect(groups[1].entries.map(entry => entry.key)).toEqual(['desktop:t2', 'remote:c:pty-1'])
  })

  it('filters by source and searches name, project and device', () => {
    expect(groupTerminalOverview(entries, projects, 'mobile').flatMap(group => group.entries.map(entry => entry.key)))
      .toEqual(['mobile:mobile-1', 'mobile:mobile-9'])
    expect(groupTerminalOverview(entries, projects, 'all', 'pixel').flatMap(group => group.entries.map(entry => entry.key)))
      .toEqual(['mobile:mobile-1', 'mobile:mobile-9'])
    expect(groupTerminalOverview(entries, projects, 'all', 'beta').map(group => group.projectId)).toEqual(['b'])
    expect(groupTerminalOverview(entries, projects, 'remote', 'alpha')).toEqual([])
  })

  it('searches extra describe text such as status and source labels', () => {
    const describe = (entry: (typeof entries)[number]) => [entry.source === 'remote' ? '远端 未接回' : '']
    expect(
      groupTerminalOverview(entries, projects, 'all', '未接回', describe).flatMap(group => group.entries.map(entry => entry.key)),
    ).toEqual(['remote:c:pty-1'])
    // 多个关键词需全部命中（不区分顺序）
    expect(
      groupTerminalOverview(entries, projects, 'all', 'beta 远端', describe).flatMap(group => group.entries.map(entry => entry.key)),
    ).toEqual(['remote:c:pty-1'])
  })

  it('treats exited desktop tabs and ended phone sessions as exited; remote is always running', () => {
    const exitedTab = { ...tab('x', 'a'), status: 'exited' } as TerminalTab
    const endedPhone = { ...mobile('mobile-2', 'a'), exit: { exitCode: 0, disconnected: false } }
    const all = terminalOverviewEntries({ projects, terminals: [exitedTab], mobile: [endedPhone], detached: [] })
    expect(all.map(isTerminalOverviewEntryExited)).toEqual([true, true])
    expect(entries.filter(entry => entry.source === 'remote').map(isTerminalOverviewEntryExited)).toEqual([false])
    expect(summarizeTerminalOverviewBatch([...all, ...entries])).toEqual({ total: 7, running: 5, exited: 2 })
  })

  it('paginates by entry count across groups and clamps out-of-range pages', () => {
    const make = (id: string, count: number): TerminalOverviewGroup => ({
      projectId: id,
      projectName: id,
      missing: false,
      entries: terminalOverviewEntries({
        projects,
        terminals: Array.from({ length: count }, (_, index) => tab(`${id}${index}`, id)),
        mobile: [],
        detached: [],
      }),
    })
    const groups = [make('a', 3), make('b', 4)]
    const first = paginateTerminalOverview(groups, 0, 5)
    expect(first.pageCount).toBe(2)
    expect(first.total).toBe(7)
    expect(first.groups.map(group => [group.projectId, group.entries.length, group.total])).toEqual([
      ['a', 3, 3],
      ['b', 2, 4],
    ])
    const second = paginateTerminalOverview(groups, 1, 5)
    expect(second.groups.map(group => group.entries.map(entry => entry.name))).toEqual([['b2', 'b3']])
    expect(paginateTerminalOverview(groups, 9, 5).page).toBe(1)
    expect(paginateTerminalOverview([], 3, 5)).toEqual({ groups: [], page: 0, pageCount: 1, total: 0 })
    for (const invalid of [NaN, Infinity, -Infinity, 0, -4]) {
      expect(paginateTerminalOverview(groups, 0, invalid).groups[0].entries).toHaveLength(1)
    }
    expect(paginateTerminalOverview(groups, NaN, 5).page).toBe(0)
    expect(paginateTerminalOverview(groups, Infinity, 5).page).toBe(1)
  })

  it('strips only spinner frames from program titles and keeps everything else', () => {
    expect(mobileSessionDisplayName({ name: '⠋ 构建', customName: null })).toBe('构建')
    expect(mobileSessionDisplayName({ name: '\u2800 构建', customName: null })).toBe('构建')
    expect(mobileSessionDisplayName({ name: '◐ Claude Code', customName: null })).toBe('Claude Code')
    expect(mobileSessionDisplayName({ name: '✳ Claude Code', customName: null })).toBe('✳ Claude Code')
    expect(mobileSessionDisplayName({ name: '⠋ 我的名字', customName: '⠋ 我的名字' })).toBe('⠋ 我的名字')
    expect(mobileSessionDisplayName({ name: '⠋', customName: null })).toBe('⠋')
    const [entry] = terminalOverviewEntries({
      projects,
      terminals: [],
      mobile: [{ ...mobile('mobile-3', 'a'), name: '⠙ 统一新建终端' }],
      detached: [],
    })
    expect(entry.name).toBe('统一新建终端')
  })

  it('reports idle minutes only after a full minute', () => {
    expect(idleMinutes(0, 1_000_000)).toBeNull()
    expect(idleMinutes(1_000_000, 1_030_000)).toBeNull()
    expect(idleMinutes(1_000_000, 1_000_000 + 3 * 60_000 + 5)).toBe(3)
  })
})

describe('parseMobileSessionSummary', () => {
  it('accepts only mobile ids with a project and normalizes optional fields', () => {
    expect(parseMobileSessionSummary({ id: 'term-1', project: { id: 'a', name: 'A' } })).toBeNull()
    expect(parseMobileSessionSummary({ id: 'mobile-1' })).toBeNull()
    expect(
      parseMobileSessionSummary({
        id: 'mobile-1',
        number: 2,
        name: '',
        exit: { exitCode: 1, disconnected: false },
        project: { id: 'a', name: 'A', kind: 'weird' },
        deviceName: '',
      }),
    ).toEqual({
      id: 'mobile-1',
      number: 2,
      name: '终端 2',
      customName: null,
      programTitle: null,
      programBusy: false,
      exit: { exitCode: 1, disconnected: false },
      lastActiveAt: 0,
      createdAt: null,
      idleDeadline: null,
      project: { id: 'a', name: 'A', path: '', kind: 'local', host: '' },
      deviceName: null,
    })
  })

  it('preserves raw program titles and respects busy flags while supporting older desktops', () => {
    const base = { id: 'mobile-1', number: 1, project: { id: 'a', name: 'Alpha' } }
    expect(parseMobileSessionSummary({ ...base, name: '✳ Claude', programTitle: '✳ Claude', programBusy: true }))
      .toMatchObject({ name: '✳ Claude', programTitle: '✳ Claude', programBusy: true })
    expect(parseMobileSessionSummary({ ...base, name: '⠋ Work' }))
      .toMatchObject({ name: '⠋ Work', programBusy: true })
    expect(parseMobileSessionSummary({ ...base, name: '⠋ Manual', customName: '⠋ Manual' })?.programBusy).toBe(false)
    expect(parseMobileSessionSummary({ ...base, name: '⠋ Work', programBusy: false })?.programBusy).toBe(false)
    expect(parseMobileSessionSummary({ ...base, name: '⠋ Work', programBusy: true, exit: { exitCode: 0 } })?.programBusy).toBe(false)
  })
})

describe('terminal overview running state and created time', () => {
  it('formats created time as HH:mm today, MM-DD within the year, full date otherwise', () => {
    const now = new Date(2026, 10, 7, 23, 40).getTime()
    expect(formatCreatedTime(new Date(2026, 10, 7, 9, 5).getTime(), now)).toBe('09:05')
    expect(formatCreatedTime(new Date(2026, 0, 3, 18, 30).getTime(), now)).toBe('01-03 18:30')
    expect(formatCreatedTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe('2025-12-31 08:00')
    expect(formatCreatedTime(null, now)).toBeNull()
    expect(formatCreatedTime(0, now)).toBeNull()
  })

  it('shortens created time for list rows: time today, date on earlier days', () => {
    const now = new Date(2026, 10, 7, 23, 40).getTime()
    expect(formatCompactCreatedTime(new Date(2026, 10, 7, 9, 5).getTime(), now)).toBe('09:05')
    expect(formatCompactCreatedTime(new Date(2026, 10, 6, 23, 59).getTime(), now)).toBe('11-06')
    expect(formatCompactCreatedTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe('2025-12-31')
    expect(formatCompactCreatedTime(undefined, now)).toBeNull()
  })

  it('formats the full created time for tooltips', () => {
    expect(formatFullCreatedTime(new Date(2026, 0, 3, 18, 30).getTime())).toBe('2026-01-03 18:30')
    expect(formatFullCreatedTime(null)).toBeNull()
  })

  it('treats only working programs as running and sorts them first within a project', () => {
    const busyPhone = { ...mobile('mobile-2', 'a'), programBusy: true }
    const endedBusy = { ...mobile('mobile-3', 'a'), programBusy: true, exit: { exitCode: 0, disconnected: false } }
    const entries = terminalOverviewEntries({
      projects,
      terminals: [tab('idle', 'a'), tab('busy', 'a'), { ...tab('gone', 'a'), status: 'exited' }],
      mobile: [mobile('mobile-1', 'a'), busyPhone, endedBusy],
      detached: [],
    })
    const desktopBusy = (terminal: TerminalTab) => terminal.id === 'busy' || terminal.id === 'gone'
    const running = (entry: (typeof entries)[number]) => isTerminalOverviewEntryRunning(entry, desktopBusy)
    expect(entries.filter(running).map(entry => entry.key)).toEqual(['desktop:busy', 'mobile:mobile-2'])
    expect(groupTerminalOverview(entries, projects, 'all', '', undefined, running)[0].entries.map(entry => entry.key)).toEqual([
      'desktop:busy', 'mobile:mobile-2', 'desktop:idle', 'desktop:gone', 'mobile:mobile-1', 'mobile:mobile-3',
    ])
  })
})
