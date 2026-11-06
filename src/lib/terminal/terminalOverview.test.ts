import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../types'
import type { MobileSessionSummary } from '../ipc/mobileSessions'
import { parseMobileSessionSummary } from '../ipc/mobileSessions'
import {
  countTerminalOverview,
  groupTerminalOverview,
  idleMinutes,
  terminalOverviewEntries,
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
      exit: { exitCode: 1, disconnected: false },
      lastActiveAt: 0,
      idleDeadline: null,
      project: { id: 'a', name: 'A', path: '', kind: 'local', host: '' },
      deviceName: null,
    })
  })
})
