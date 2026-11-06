import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '@/types'
import { assertCliTerminalWritable, cliTerminalSummary, resolveCliTerminal } from './cliTerminal'

function tab(partial: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    name: partial.id,
    projectId: 'p1',
    cwd: '/srv/app',
    launchCommand: '',
    status: 'running',
    exitCode: null,
    ...partial,
  } as TerminalTab
}

describe('resolveCliTerminal', () => {
  const terminals = [
    tab({ id: 'a', name: 'shell' }),
    tab({ id: 'b', name: 'dup' }),
    tab({ id: 'c', name: 'dup' }),
    tab({ id: 'other', name: 'remote', projectId: 'p2' }),
    tab({ id: 'd', name: 'remote' }),
  ]

  it('prefers the id, then a unique name', () => {
    expect(resolveCliTerminal(terminals, 'p1', 'a').id).toBe('a')
    expect(resolveCliTerminal(terminals, 'p1', ' shell ').id).toBe('a')
  })

  it('never resolves a terminal owned by another project', () => {
    expect(() => resolveCliTerminal(terminals, 'p1', 'other')).toThrow('terminal not found')
    expect(resolveCliTerminal(terminals, 'p1', 'remote').id).toBe('d')
  })

  it('rejects ambiguous names', () => {
    expect(() => resolveCliTerminal(terminals, 'p1', 'dup')).toThrow('ambiguous')
    expect(resolveCliTerminal(terminals, 'p1', 'b').id).toBe('b')
  })
})

describe('assertCliTerminalWritable', () => {
  it('accepts only a fully started running terminal', () => {
    expect(() => assertCliTerminalWritable(tab({ id: 'a' }))).not.toThrow()
    for (const status of ['starting', 'reconnecting', 'exited'] as const) {
      expect(() => assertCliTerminalWritable(tab({ id: 'a', status }))).toThrow(status)
    }
    expect(() => assertCliTerminalWritable(tab({ id: 'a', ptySpawnPending: true }))).toThrow(
      'starting'
    )
  })
})

describe('cliTerminalSummary', () => {
  it('reports writability and omits launch command and env', () => {
    const summary = cliTerminalSummary(
      tab({ id: 'a', launchCommand: 'TOKEN=1 run', env: { SECRET: 'x' }, status: 'exited' })
    )
    expect(summary).toMatchObject({ id: 'a', status: 'exited', writable: false })
    expect(JSON.stringify(summary)).not.toMatch(/TOKEN|SECRET/)
  })
})
