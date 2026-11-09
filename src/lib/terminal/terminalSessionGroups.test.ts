import { describe, expect, it } from 'vitest'
import type { Project, SshConnection, TerminalTab } from '../../types'
import {
  groupTerminalSessions,
  parseCollapsedProjects,
  terminalProjectSources,
} from './terminalSessionGroups'

const project = (id: string, overrides: Partial<Project> = {}) =>
  ({ id, name: id, path: `/${id}`, ...overrides }) as Project

const terminal = (id: string, projectId: string, status: TerminalTab['status'] = 'running') =>
  ({ id, projectId, status }) as TerminalTab

describe('groupTerminalSessions', () => {
  it('keeps project order and puts the pinned project first', () => {
    const groups = groupTerminalSessions([project('a'), project('b'), project('c')], [], 'c')
    expect(groups.map(group => group.project.id)).toEqual(['c', 'a', 'b'])
  })

  it('assigns terminals to their project', () => {
    const [a, b] = groupTerminalSessions(
      [project('a'), project('b')],
      [terminal('1', 'a'), terminal('2', 'b', 'exited'), terminal('3', 'a', 'starting')],
      null,
    )
    expect(a.terminals.map(t => t.id)).toEqual(['1', '3'])
    expect(b.terminals.map(t => t.id)).toEqual(['2'])
  })

  it('lists empty projects but hides hidden ones unless they own terminals', () => {
    const groups = groupTerminalSessions(
      [project('empty'), project('hidden', { hidden: 1 }), project('busy', { hidden: 1 })],
      [terminal('1', 'busy')],
      null,
    )
    expect(groups.map(group => group.project.id)).toEqual(['empty', 'busy'])
  })

  it('leaves out terminals whose project is gone', () => {
    const groups = groupTerminalSessions([project('a')], [terminal('1', 'removed')], 'removed')
    expect(groups).toHaveLength(1)
    expect(groups[0].terminals).toEqual([])
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
