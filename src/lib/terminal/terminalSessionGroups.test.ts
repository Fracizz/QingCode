import { describe, expect, it } from 'vitest'
import type { Project, TerminalTab } from '../../types'
import { groupTerminalSessions, parseCollapsedProjects } from './terminalSessionGroups'

const project = (id: string, overrides: Partial<Project> = {}) =>
  ({ id, name: id, path: `/${id}`, ...overrides }) as Project

const terminal = (id: string, projectId: string, status: TerminalTab['status'] = 'running') =>
  ({ id, projectId, status }) as TerminalTab

describe('groupTerminalSessions', () => {
  it('keeps project order and puts the pinned project first', () => {
    const groups = groupTerminalSessions([project('a'), project('b'), project('c')], [], 'c')
    expect(groups.map(group => group.project.id)).toEqual(['c', 'a', 'b'])
  })

  it('assigns terminals to their project and counts the ones still running', () => {
    const [a, b] = groupTerminalSessions(
      [project('a'), project('b')],
      [terminal('1', 'a'), terminal('2', 'b', 'exited'), terminal('3', 'a', 'starting')],
      null,
    )
    expect(a.terminals.map(t => t.id)).toEqual(['1', '3'])
    expect(a.running).toBe(2)
    expect(b.running).toBe(0)
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

describe('parseCollapsedProjects', () => {
  it('reads stored ids and treats corrupt data as nothing collapsed', () => {
    expect([...parseCollapsedProjects('["a","b",1]')]).toEqual(['a', 'b'])
    expect(parseCollapsedProjects('{oops').size).toBe(0)
    expect(parseCollapsedProjects('{"a":1}').size).toBe(0)
    expect(parseCollapsedProjects(null).size).toBe(0)
  })
})
