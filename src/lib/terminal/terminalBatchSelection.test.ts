import { describe, expect, it } from 'vitest'
import {
  allTerminalsSelected,
  isEndedTerminal,
  prunedTerminalSelection,
  toggleTerminalSelection,
} from './terminalBatchSelection'

describe('terminalBatchSelection', () => {
  it('prunes ids that no longer exist and keeps order', () => {
    const result = prunedTerminalSelection(new Set(['b', 'x', 'a']), [{ id: 'a' }, { id: 'b' }])
    expect([...result]).toEqual(['b', 'a'])
  })

  it('toggles without mutating the input', () => {
    const base = new Set(['a'])
    expect([...toggleTerminalSelection(base, 'b')]).toEqual(['a', 'b'])
    expect([...toggleTerminalSelection(base, 'a')]).toEqual([])
    expect([...base]).toEqual(['a'])
  })

  it('treats awaiting-restore terminals as not ended', () => {
    expect(isEndedTerminal({ status: 'exited' })).toBe(true)
    expect(isEndedTerminal({ status: 'exited', awaitingRestoreSpawn: true })).toBe(false)
    expect(isEndedTerminal({ status: 'running' })).toBe(false)
  })

  it('reports all-selected only for a non-empty list', () => {
    expect(allTerminalsSelected(new Set(), [])).toBe(false)
    expect(allTerminalsSelected(new Set(['a']), [{ id: 'a' }])).toBe(true)
    expect(allTerminalsSelected(new Set(['a']), [{ id: 'a' }, { id: 'b' }])).toBe(false)
  })
})
