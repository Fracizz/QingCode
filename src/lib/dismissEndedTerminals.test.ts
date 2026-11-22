import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { TerminalTab } from '../types'

const mocks = vi.hoisted(() => ({ store: null as unknown as ReturnType<typeof makeStore> }))

function makeStore() {
  return create<{ terminals: TerminalTab[]; closeTerminal: (id: string) => Promise<void> }>()(set => ({
    terminals: [],
    closeTerminal: vi.fn(async (id: string) => set(s => ({ terminals: s.terminals.filter(tab => tab.id !== id) }))),
  }))
}

vi.mock('../store/terminalStore', () => ({
  get useTerminalStore() { return mocks.store },
}))

import { dismissTerminalsWhenEnded, endedTerminalIds, liveTerminalIdsOnConnection } from './dismissEndedTerminals'

const tab = (id: string, connectionId: string | undefined, status: TerminalTab['status']): TerminalTab => ({
  id, name: id, projectId: 'p', cwd: '/', launchCommand: '', status, exitCode: null, connectionId,
})

const setStatus = (id: string, status: TerminalTab['status']) =>
  mocks.store.setState(s => ({ terminals: s.terminals.map(t => (t.id === id ? { ...t, status } : t)) }))

afterEach(() => vi.useRealTimers())

describe('dismissEndedTerminals', () => {
  it('只选该连接上未退出的标签', () => {
    const terminals = [tab('a', 'c1', 'running'), tab('b', 'c1', 'exited'), tab('c', 'c2', 'running'), tab('d', undefined, 'running')]
    expect(liveTerminalIdsOnConnection(terminals, 'c1')).toEqual(['a'])
    expect(endedTerminalIds(terminals, new Set(['a', 'b']))).toEqual(['b'])
  })

  it('更新前在运行的标签退出后被关闭，其他连接与原本已退出的标签保留', () => {
    mocks.store = makeStore()
    mocks.store.setState({ terminals: [tab('a', 'c1', 'running'), tab('b', 'c1', 'reconnecting'), tab('old', 'c1', 'exited'), tab('c', 'c2', 'running')] })
    dismissTerminalsWhenEnded('c1')
    setStatus('a', 'exited')
    setStatus('c', 'exited')
    expect(mocks.store.getState().terminals.map(t => t.id)).toEqual(['b', 'old', 'c'])
    setStatus('b', 'exited')
    expect(mocks.store.getState().terminals.map(t => t.id)).toEqual(['old', 'c'])
    expect(mocks.store.getState().closeTerminal).toHaveBeenCalledTimes(2)
  })

  it('超时后不再关闭', () => {
    vi.useFakeTimers()
    mocks.store = makeStore()
    mocks.store.setState({ terminals: [tab('a', 'c1', 'running')] })
    dismissTerminalsWhenEnded('c1', 1000)
    vi.advanceTimersByTime(1001)
    setStatus('a', 'exited')
    expect(mocks.store.getState().closeTerminal).not.toHaveBeenCalled()
  })
})
