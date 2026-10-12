// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../types'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  refreshTree: vi.fn(async () => {}),
  safeInvoke: vi.fn(async () => {}),
  skipTree: vi.fn(async () => false),
  syncFiles: vi.fn(async () => {}),
  gitRefresh: vi.fn(async () => {}),
  gitSchedule: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  isSshResource: (path: string) => path.startsWith('ssh://'),
  safeInvoke: mocks.safeInvoke,
}))
vi.mock('../store/projectStore', async () => {
  const { create } = await import('zustand')
  return { useProjectStore: create(() => ({
    projects: [], currentProject: null, refreshProjectTree: mocks.refreshTree,
  })) }
})
vi.mock('../store/editorStore', async () => {
  const { create } = await import('zustand')
  return { useEditorStore: create(() => ({ tabs: [], projectSessions: {}, activeTabId: null })) }
})
vi.mock('../store/gitStatusStore', () => ({ useGitStatusStore: { getState: () => ({
  refresh: mocks.gitRefresh, clear: vi.fn(), scheduleRefresh: mocks.gitSchedule,
}) } }))
vi.mock('../lib/syncOpenFileFromDiskDeps', () => ({ createDefaultSyncOpenFileDeps: () => ({}) }))
vi.mock('../lib/syncOpenFileFromDisk', () => ({
  collectSyncableOpenTabs: () => [], findOpenTabByPath: () => undefined,
  syncOpenFilesOnFocus: mocks.syncFiles, syncOpenFileFromDisk: vi.fn(),
}))
vi.mock('../lib/watcherTreeRefresh', () => ({ shouldSkipWatcherTreeRefresh: mocks.skipTree }))
vi.mock('../lib/performanceDiagnostics', () => ({ recordPerformanceThroughput: vi.fn() }))
vi.mock('../lib/gitRefreshSettings', () => ({
  getGitRefreshIntervalStartMinutes: () => 5,
  GIT_REFRESH_INTERVAL_START_EVENT: 'test:git-interval',
}))
vi.mock('../lib/projectIndicators', () => ({ projectGitRefreshDelay: () => 300000 }))

import { useProjectStore } from '../store/projectStore'
import { useFileWatcher, type FsChangePayload } from './useFileWatcher'

const local: Project = { id: 'local', name: 'local', path: 'D:/project', created_at: 0, last_opened_at: 0 }
let emit: (event: { payload: FsChangePayload }) => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.skipTree.mockResolvedValue(false)
  mocks.listen.mockImplementation(async (_name, callback) => {
    emit = callback
    return vi.fn()
  })
  useProjectStore.setState({ projects: [local], currentProject: local })
})
afterEach(() => vi.useRealTimers())
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const change = (path: string) => emit({ payload: { path, kind: 'any', isDir: false } })

describe('file watcher explorer updates', () => {
  it('refreshes the whole loaded tree for a batch affecting more than four directories', async () => {
    renderHook(() => useFileWatcher())
    act(() => {
      for (let i = 0; i < 8; i++) change(`D:/project/dir${i}/new.txt`)
    })
    await advance(500)
    expect(mocks.refreshTree).toHaveBeenCalledExactlyOnceWith(local)
  })

  it('does not postpone explorer updates until continuous writes stop', async () => {
    renderHook(() => useFileWatcher())
    for (let i = 0; i < 10; i++) {
      act(() => change(`D:/project/file${i}.txt`))
      await advance(100)
    }
    expect(mocks.refreshTree).toHaveBeenCalledTimes(2)
  })

  it('rescans the local tree and re-registers watches on focus', async () => {
    renderHook(() => useFileWatcher())
    await advance(100)
    mocks.safeInvoke.mockClear()
    act(() => window.dispatchEvent(new Event('focus')))
    await advance(700)
    expect(mocks.refreshTree).toHaveBeenCalledExactlyOnceWith(local)
    expect(mocks.safeInvoke).toHaveBeenCalledWith('同步文件监视', 'sync_file_watches', {
      roots: [local.path], files: [],
    })
    expect(mocks.syncFiles).toHaveBeenCalled()
  })

  it('does not start unattended SSH tree scans on focus', async () => {
    const remote: Project = { ...local, path: 'ssh://connection/home/team/project', kind: 'ssh' }
    useProjectStore.setState({ projects: [remote], currentProject: remote })
    renderHook(() => useFileWatcher())
    act(() => window.dispatchEvent(new Event('focus')))
    await advance(1000)
    expect(mocks.refreshTree).not.toHaveBeenCalled()
  })

  it('allows a normal file change after excluded events in the same batch', async () => {
    mocks.skipTree.mockImplementation(async path => path.includes('/target/'))
    renderHook(() => useFileWatcher())
    act(() => {
      change('D:/project/target/temporary.txt')
      change('D:/project/docs/new.txt')
    })
    await advance(500)
    expect(mocks.refreshTree).toHaveBeenCalledExactlyOnceWith(local)
  })
})
