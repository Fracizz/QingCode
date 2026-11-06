import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../types'
import type { MobileSessionSummary } from '../ipc/mobileSessions'
import { parseMobileSessionSummary } from '../ipc/mobileSessions'
import {
  countTerminalOverview,
  groupTerminalOverview,
  idleMinutes,
  isTerminalOverviewEntryExited,
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
      programBusy: false,
      exit: { exitCode: 1, disconnected: false },
      lastActiveAt: 0,
      idleDeadline: null,
      project: { id: 'a', name: 'A', path: '', kind: 'local', host: '' },
      deviceName: null,
    })
  })
})
