import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalAttention,
  getTerminalAttentionSnapshot,
  markTerminalAttention,
  noteTerminalBusyChange,
  noteTerminalLeftView,
  pruneTerminalAttention,
  subscribeTerminalAttention,
  syncTerminalsInView,
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

  it('does not mark a task that ended before the user switched away', () => {
    noteTerminalBusyChange('t1', true, true, 1000)
    noteTerminalLeftView('t1', 2000)
    // 保持期在切走后才到期，最后的工作信号仍早于切走时刻。
    noteTerminalBusyChange('t1', false, false, 1000)
    expect(getTerminalAttentionSnapshot().size).toBe(0)
  })

  it('marks a task that kept working after the user switched away', () => {
    noteTerminalBusyChange('t1', true, true, 1000)
    noteTerminalLeftView('t1', 2000)
    noteTerminalBusyChange('t1', false, false, 2500)
    expect(getTerminalAttentionSnapshot().has('t1')).toBe(true)
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

  it('clears a mark once the terminal comes into view, even if it was already the current one', () => {
    // 切到别的项目时当前终端绑定可能没变；切回来时它重新显示，也算看过。
    syncTerminalsInView(new Set(['t1']))
    syncTerminalsInView(new Set())
    markTerminalAttention('t1')
    markTerminalAttention('t2')
    syncTerminalsInView(new Set(['t1']))
    expect([...getTerminalAttentionSnapshot()]).toEqual(['t2'])
  })

  it('records the leave time for every terminal that leaves view', () => {
    syncTerminalsInView(new Set(['t1', 't2']), 1000)
    noteTerminalBusyChange('t1', true, true, 500)
    noteTerminalBusyChange('t2', true, true, 500)
    // 两个终端一起离开视野（如切走项目），之前就停下的任务不算新结果。
    syncTerminalsInView(new Set(), 2000)
    noteTerminalBusyChange('t1', false, false, 1500)
    noteTerminalBusyChange('t2', false, false, 2500)
    expect([...getTerminalAttentionSnapshot()]).toEqual(['t2'])
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
