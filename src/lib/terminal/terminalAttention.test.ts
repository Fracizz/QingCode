import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalAttention,
  getTerminalAttentionSnapshot,
  markTerminalAttention,
  noteTerminalBusyChange,
  pruneTerminalAttention,
  subscribeTerminalAttention,
} from './terminalAttention'

describe('terminalAttention', () => {
  beforeEach(() => {
    pruneTerminalAttention(new Set())
  })

  it('marks a background terminal when its task finishes', () => {
    noteTerminalBusyChange('t1', true, false)
    expect(getTerminalAttentionSnapshot().has('t1')).toBe(false)
    noteTerminalBusyChange('t1', false, false)
    expect(getTerminalAttentionSnapshot().has('t1')).toBe(true)
  })

  it('does not mark a terminal that is in view', () => {
    noteTerminalBusyChange('t1', true, true)
    noteTerminalBusyChange('t1', false, true)
    expect(getTerminalAttentionSnapshot().size).toBe(0)
  })

  it('ignores an idle notification without a preceding busy state', () => {
    noteTerminalBusyChange('t1', false, false)
    expect(getTerminalAttentionSnapshot().size).toBe(0)
  })

  it('clears a mark and keeps the snapshot stable when nothing changes', () => {
    markTerminalAttention('t1')
    const snapshot = getTerminalAttentionSnapshot()
    markTerminalAttention('t1')
    clearTerminalAttention('missing')
    expect(getTerminalAttentionSnapshot()).toBe(snapshot)
    clearTerminalAttention('t1')
    expect(getTerminalAttentionSnapshot().has('t1')).toBe(false)
  })

  it('drops marks and busy records of closed terminals', () => {
    markTerminalAttention('closed')
    markTerminalAttention('alive')
    noteTerminalBusyChange('busy-closed', true, false)
    pruneTerminalAttention(new Set(['alive']))
    expect([...getTerminalAttentionSnapshot()]).toEqual(['alive'])
    noteTerminalBusyChange('busy-closed', false, false)
    expect(getTerminalAttentionSnapshot().has('busy-closed')).toBe(false)
  })

  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalAttention(listener)
    markTerminalAttention('t1')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    clearTerminalAttention('t1')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
