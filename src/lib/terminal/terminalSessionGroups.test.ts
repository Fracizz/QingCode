import { describe, expect, it } from 'vitest'
import type { Project, SshConnection, TerminalTab } from '../../types'
import {
  filterTerminalSessionGroups,
  groupTerminalSessions,
  parseCollapsedProjects,
  terminalProjectMove,
  terminalProjectSources,
  terminalRemoteScopeOptions,
} from './terminalSessionGroups'

const project = (id: string, overrides: Partial<Project> = {}) =>
  ({ id, name: id, path: `/${id}`, ...overrides }) as Project

const terminal = (id: string, projectId: string, status: TerminalTab['status'] = 'running') =>
  ({ id, projectId, status }) as TerminalTab

describe('filterTerminalSessionGroups', () => {
  const named = (id: string, name: string, projectId: string) =>
    ({ ...terminal(id, projectId), name }) as TerminalTab
  const groups = [
    { project: project('web', { name: 'web' }), terminals: [named('1', 'claude', 'web'), named('2', 'dev server', 'web')] },
    { project: project('api', { name: 'api' }), terminals: [named('3', 'claude', 'api')] },
    { project: project('empty', { name: 'empty' }), terminals: [] },
  ]
  const sources = new Map([['web', '本机'], ['api', 'WinDev']])
  const ids = (result: ReturnType<typeof filterTerminalSessionGroups>) =>
    result.map(group => [group.project.id, group.terminals.map(item => item.id)])

  it('keeps every group, including empty ones, without a query', () => {
    expect(ids(filterTerminalSessionGroups(groups, { query: '  ', sources }))).toEqual([
      ['web', ['1', '2']],
      ['api', ['3']],
      ['empty', []],
    ])
  })

  it('matches terminal names case-insensitively and drops groups without results', () => {
    expect(ids(filterTerminalSessionGroups(groups, { query: 'SERVER', sources }))).toEqual([['web', ['2']]])
  })

  it('matches the project name and source, requiring every keyword', () => {
    expect(ids(filterTerminalSessionGroups(groups, { query: 'api', sources }))).toEqual([['api', ['3']]])
    expect(ids(filterTerminalSessionGroups(groups, { query: 'windev claude', sources }))).toEqual([['api', ['3']]])
    expect(ids(filterTerminalSessionGroups(groups, { query: 'windev dev', sources }))).toEqual([['api', ['3']]])
    expect(ids(filterTerminalSessionGroups(groups, { query: '本机 missing', sources }))).toEqual([])
  })

  it('finds projects without terminals by name and source without keeping unrelated empty groups', () => {
    const emptySources = new Map([...sources, ['empty', 'WSL · Ubuntu']])
    expect(ids(filterTerminalSessionGroups(groups, { query: 'EMPTY ubuntu', sources: emptySources }))).toEqual([['empty', []]])
    expect(ids(filterTerminalSessionGroups(groups, { query: 'wsl missing', sources: emptySources }))).toEqual([])
    expect(ids(filterTerminalSessionGroups(groups, { query: 'claude', sources: emptySources }))).toEqual([
      ['web', ['1']],
      ['api', ['3']],
    ])
  })

  it('moves running terminals first within a group and keeps their order', () => {
    const running = (item: TerminalTab) => item.id === '2'
    expect(ids(filterTerminalSessionGroups(groups, { query: '', sources, running }))[0]).toEqual(['web', ['2', '1']])
    expect(groups[0].terminals.map(item => item.id)).toEqual(['1', '2'])
  })
})

describe('groupTerminalSessions', () => {
  it('follows the title-bar order and lists hidden projects last', () => {
    const groups = groupTerminalSessions(
      [
        project('hidden', { hidden: 1, sort_order: 0 }),
        project('c', { sort_order: 2 }),
        project('a', { sort_order: 0 }),
        project('b', { sort_order: 1 }),
      ],
      [terminal('1', 'hidden')],
    )
    expect(groups.map(group => group.project.id)).toEqual(['a', 'b', 'c', 'hidden'])
  })

  it('assigns terminals to their project', () => {
    const [a, b] = groupTerminalSessions(
      [project('a'), project('b')],
      [terminal('1', 'a'), terminal('2', 'b', 'exited'), terminal('3', 'a', 'starting')],
    )
    expect(a.terminals.map(t => t.id)).toEqual(['1', '3'])
    expect(b.terminals.map(t => t.id)).toEqual(['2'])
  })

  it('lists empty projects but hides hidden ones unless they own terminals', () => {
    const groups = groupTerminalSessions(
      [project('empty'), project('hidden', { hidden: 1 }), project('busy', { hidden: 1 })],
      [terminal('1', 'busy')],
    )
    expect(groups.map(group => group.project.id)).toEqual(['empty', 'busy'])
  })

  it('leaves out terminals whose project is gone', () => {
    const groups = groupTerminalSessions([project('a')], [terminal('1', 'removed')])
    expect(groups).toHaveLength(1)
    expect(groups[0].terminals).toEqual([])
  })
})

describe('terminalProjectMove', () => {
  const list = [project('a'), project('b'), project('c'), project('hidden', { hidden: 1 })]

  it('converts a drop position into reorder indexes in both directions', () => {
    expect(terminalProjectMove(list, 'a', 'c', 'after')).toEqual({ fromIndex: 0, toIndex: 2 })
    expect(terminalProjectMove(list, 'a', 'c', 'before')).toEqual({ fromIndex: 0, toIndex: 1 })
    expect(terminalProjectMove(list, 'c', 'a', 'before')).toEqual({ fromIndex: 2, toIndex: 0 })
    expect(terminalProjectMove(list, 'c', 'a', 'after')).toEqual({ fromIndex: 2, toIndex: 1 })
  })

  it('ignores drops that change nothing and hidden projects', () => {
    expect(terminalProjectMove(list, 'a', 'b', 'before')).toBeNull()
    expect(terminalProjectMove(list, 'b', 'a', 'after')).toBeNull()
    expect(terminalProjectMove(list, 'a', 'a', 'after')).toBeNull()
    expect(terminalProjectMove(list, 'hidden', 'a', 'before')).toBeNull()
    expect(terminalProjectMove(list, 'a', 'hidden', 'after')).toBeNull()
  })
})

describe('terminalProjectSources', () => {
  const translate = (source: string) => source
  const connections = [
    { id: 'conn', name: 'WinDev', host: '192.168.252.107' },
    { id: 'unnamed', name: '', host: '10.0.0.1' },
  ] as SshConnection[]
  const ssh = (id: string, connectionId: string, name = id, root = `/srv/${id}`) =>
    project(id, { name, kind: 'ssh', connection_id: connectionId, root_path: root, path: `ssh://${connectionId}${root}` })

  it('labels local, WSL and SSH projects by where they live', () => {
    const sources = terminalProjectSources(
      [
        project('local', { path: 'D:\\code\\local' }),
        project('wsl', { kind: 'wsl', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\wsl' }),
        ssh('named', 'conn'),
        ssh('host-only', 'unnamed'),
        ssh('orphan', 'gone'),
      ],
      connections,
      translate,
    )
    expect(Object.fromEntries(sources)).toEqual({
      local: '本机',
      wsl: 'WSL · Ubuntu',
      named: 'WinDev',
      'host-only': '10.0.0.1',
      orphan: '远端',
    })
  })

  it('adds the parent folder only when name and source both collide', () => {
    const sources = terminalProjectSources(
      [
        project('a', { name: 'nem-panel', path: 'D:\\code\\nem-panel' }),
        project('b', { name: 'nem-panel', path: 'E:\\work\\nem-panel' }),
        ssh('c', 'conn', 'nem-panel', '/srv/nem-panel'),
      ],
      connections,
      translate,
    )
    expect(sources.get('a')).toBe('本机 · code')
    expect(sources.get('b')).toBe('本机 · work')
    expect(sources.get('c')).toBe('WinDev')
  })
})

describe('parseCollapsedProjects', () => {
  it('reads stored ids and treats corrupt data as nothing collapsed', () => {
    expect([...parseCollapsedProjects('["a","b",1]')]).toEqual(['a', 'b'])
    expect(parseCollapsedProjects('{oops').size).toBe(0)
    expect(parseCollapsedProjects('{"a":1}').size).toBe(0)
    expect(parseCollapsedProjects(null).size).toBe(0)
  })
})

describe('terminal scope filter', () => {
  const ssh = (id: string, connectionId: string) =>
    project(id, { kind: 'ssh', connection_id: connectionId, path: `ssh://${connectionId}/srv/${id}` } as Partial<Project>)
  const connections = [
    { id: 'c1', name: 'WinDev', host: 'h1' },
    { id: 'c2', name: 'Box', host: 'h2' },
  ] as SshConnection[]
  const groups = [
    { project: project('local'), terminals: [terminal('1', 'local'), terminal('2', 'local')] },
    { project: ssh('a', 'c1'), terminals: [terminal('3', 'a')] },
    { project: ssh('b', 'c2'), terminals: [terminal('4', 'b')] },
  ]
  const sources = new Map<string, string>()
  const ids = (scope: string) =>
    filterTerminalSessionGroups(groups, { query: '', sources, scope }).map(group => group.project.id)

  it('filters local, all remote and a single connection', () => {
    expect(ids('all')).toEqual(['local', 'a', 'b'])
    expect(ids('local')).toEqual(['local'])
    expect(ids('remote')).toEqual(['a', 'b'])
    expect(ids('ssh:c2')).toEqual(['b'])
  })

  it('lists remote sources with terminal counts', () => {
    expect(terminalRemoteScopeOptions(groups, connections, text => text)).toEqual([
      { key: 'ssh:c1', label: 'WinDev', count: 1 },
      { key: 'ssh:c2', label: 'Box', count: 1 },
    ])
  })
})
