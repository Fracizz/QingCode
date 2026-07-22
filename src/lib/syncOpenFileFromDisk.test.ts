import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { EditorTab } from '../types'
import {
  collectSyncableOpenTabs,
  findOpenTabByPath,
  resetOpenFileSyncInFlightForTests,
  shouldSkipOpenFileSync,
  syncOpenFileFromDisk,
  syncOpenFilesOnFocus,
  type SyncOpenFileDeps,
} from './syncOpenFileFromDisk'

function makeTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: 'tab-1',
    path: 'D:\\proj\\a.txt',
    name: 'a.txt',
    content: 'local',
    dirty: false,
    diskMtime: 100,
    fileSize: 5,
    viewMode: 'edit',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<SyncOpenFileDeps> = {}): SyncOpenFileDeps {
  const tab = makeTab()
  return {
    isSuppressed: vi.fn(async () => false),
    fileMtime: vi.fn(async () => 200),
    readFile: vi.fn(async () => 'disk'),
    resolveEncoding: vi.fn(async () => 'utf-8'),
    resolveTab: vi.fn(() => tab),
    getLocalContent: vi.fn(t => t.content ?? ''),
    setDiskMtime: vi.fn(),
    reloadFromDisk: vi.fn(async () => {}),
    notifyViewChanged: vi.fn(),
    notifyReloaded: vi.fn(),
    promptConflict: vi.fn(async () => null),
    openCompare: vi.fn(),
    flushLive: vi.fn(),
    ...overrides,
  }
}

describe('shouldSkipOpenFileSync', () => {
  it('skips loading, error, and diff tabs', () => {
    expect(shouldSkipOpenFileSync(makeTab({ loading: true }))).toBe(true)
    expect(shouldSkipOpenFileSync(makeTab({ openError: 'boom' }))).toBe(true)
    expect(shouldSkipOpenFileSync(makeTab({ kind: 'diff' }))).toBe(true)
    expect(shouldSkipOpenFileSync(makeTab())).toBe(false)
  })
})

describe('syncOpenFileFromDisk', () => {
  beforeEach(() => {
    resetOpenFileSyncInFlightForTests()
  })

  it('returns suppressed without reading when watch is suppressed', async () => {
    const deps = makeDeps({ isSuppressed: vi.fn(async () => true) })
    const outcome = await syncOpenFileFromDisk(makeTab(), deps)
    expect(outcome).toBe('suppressed')
    expect(deps.fileMtime).not.toHaveBeenCalled()
  })

  it('ignores when mtime is unchanged for large/plain profiles', async () => {
    const tab = makeTab({ diskMtime: 50, fileSize: 6 * 1024 * 1024 })
    const deps = makeDeps({
      fileMtime: vi.fn(async () => 50),
      resolveTab: () => tab,
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('ignored')
    expect(deps.readFile).not.toHaveBeenCalled()
  })

  it('notifies view-only tabs without reading full content', async () => {
    const tab = makeTab({ viewMode: 'view', diskMtime: 100 })
    const deps = makeDeps({
      fileMtime: vi.fn(async () => 200),
      resolveTab: () => tab,
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('notify-view')
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.setDiskMtime).toHaveBeenCalledWith(tab.id, 200)
    expect(deps.notifyViewChanged).toHaveBeenCalled()
  })

  it('silently reloads clean tabs when disk content differs', async () => {
    const tab = makeTab({ content: 'local', dirty: false })
    const deps = makeDeps({
      readFile: vi.fn(async () => 'disk-new'),
      resolveTab: () => tab,
      getLocalContent: () => 'local',
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('reloaded')
    expect(deps.reloadFromDisk).toHaveBeenCalledWith(tab.id, 'disk-new', 200)
    expect(deps.notifyReloaded).toHaveBeenCalled()
    expect(deps.promptConflict).not.toHaveBeenCalled()
  })

  it('only updates mtime when clean content already matches disk', async () => {
    const tab = makeTab({ content: 'same', dirty: false })
    const deps = makeDeps({
      readFile: vi.fn(async () => 'same'),
      resolveTab: () => tab,
      getLocalContent: () => 'same',
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('update-mtime')
    expect(deps.reloadFromDisk).not.toHaveBeenCalled()
    expect(deps.setDiskMtime).toHaveBeenCalledWith(tab.id, 200)
  })

  it('prompts when the buffer is dirty and differs from disk', async () => {
    const tab = makeTab({ content: 'draft', dirty: true })
    const deps = makeDeps({
      readFile: vi.fn(async () => 'external'),
      resolveTab: () => tab,
      getLocalContent: () => 'draft',
      promptConflict: vi.fn(async () => 'keep'),
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('prompted-keep')
    expect(deps.promptConflict).toHaveBeenCalled()
    expect(deps.reloadFromDisk).not.toHaveBeenCalled()
    expect(deps.setDiskMtime).toHaveBeenCalledWith(tab.id, 200)
  })

  it('reloads after the user chooses reload on a dirty conflict', async () => {
    const tab = makeTab({ content: 'draft', dirty: true })
    const deps = makeDeps({
      readFile: vi.fn(async () => 'external'),
      resolveTab: () => tab,
      getLocalContent: () => 'draft',
      promptConflict: vi.fn(async () => 'reload'),
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('prompted-reload')
    expect(deps.reloadFromDisk).toHaveBeenCalledWith(tab.id, 'external', 200)
  })

  it('opens compare when chosen on a dirty conflict', async () => {
    const tab = makeTab({ content: 'draft', dirty: true })
    const deps = makeDeps({
      readFile: vi.fn(async () => 'external'),
      resolveTab: () => tab,
      getLocalContent: () => 'draft',
      promptConflict: vi.fn(async () => 'compare'),
    })
    const outcome = await syncOpenFileFromDisk(tab, deps)
    expect(outcome).toBe('prompted-compare')
    expect(deps.flushLive).toHaveBeenCalledWith(tab.id)
    expect(deps.openCompare).toHaveBeenCalledWith(
      expect.objectContaining({
        tab,
        localContent: 'draft',
        diskContent: 'external',
        mtime: 200,
      }),
    )
  })

  it('uses the post-await dirty flag so mid-flight edits are not silently wiped', async () => {
    const clean = makeTab({ content: 'local', dirty: false })
    const dirtyLater = makeTab({ content: 'typed', dirty: true })
    const deps = makeDeps({
      readFile: vi.fn(async () => 'disk-new'),
      resolveTab: vi.fn(() => dirtyLater),
      getLocalContent: t => t.content ?? '',
      promptConflict: vi.fn(async () => 'keep'),
    })
    const outcome = await syncOpenFileFromDisk(clean, deps)
    expect(outcome).toBe('prompted-keep')
    expect(deps.reloadFromDisk).not.toHaveBeenCalled()
    expect(deps.promptConflict).toHaveBeenCalled()
  })

  it('returns busy when a sync for the same path is already in flight', async () => {
    let release!: () => void
    const gate = new Promise<string>(resolve => {
      release = () => resolve('disk')
    })
    const tab = makeTab()
    const deps = makeDeps({
      readFile: vi.fn(() => gate),
      resolveTab: () => tab,
    })
    const first = syncOpenFileFromDisk(tab, deps)
    const second = await syncOpenFileFromDisk(tab, deps)
    expect(second).toBe('busy')
    release()
    await first
  })
})

describe('syncOpenFilesOnFocus', () => {
  beforeEach(() => {
    resetOpenFileSyncInFlightForTests()
  })

  it('skips tabs whose mtime is unchanged', async () => {
    const tab = makeTab({ diskMtime: 100 })
    const deps = makeDeps({
      fileMtime: vi.fn(async () => 100),
      listTabs: () => [tab],
      resolveTab: () => tab,
    } as SyncOpenFileDeps & { listTabs: () => EditorTab[] })
    const outcomes = await syncOpenFilesOnFocus([tab], deps)
    expect(outcomes).toEqual(['ignored'])
    expect(deps.readFile).not.toHaveBeenCalled()
  })

  it('runs full sync when focus probe sees a newer mtime', async () => {
    const tab = makeTab({ content: 'old', dirty: false, diskMtime: 100 })
    const deps = {
      ...makeDeps({
        fileMtime: vi.fn(async () => 300),
        readFile: vi.fn(async () => 'new'),
        resolveTab: () => tab,
        getLocalContent: () => 'old',
      }),
      listTabs: () => [tab],
    }
    const outcomes = await syncOpenFilesOnFocus([tab], deps)
    expect(outcomes).toEqual(['reloaded'])
    expect(deps.reloadFromDisk).toHaveBeenCalled()
  })
})

describe('tab helpers', () => {
  it('finds tabs across current and inactive project sessions', () => {
    const active = makeTab({ id: 'a', path: 'D:\\p\\a.txt' })
    const inactive = makeTab({ id: 'b', path: 'D:\\q\\b.txt' })
    expect(findOpenTabByPath([active], { other: { tabs: [inactive] } }, 'D:/q/b.txt')?.id).toBe(
      'b',
    )
  })

  it('dedupes syncable tabs by path', () => {
    const a = makeTab({ id: '1', path: 'D:\\p\\a.txt' })
    const dup = makeTab({ id: '2', path: 'D:/p/a.txt' })
    const tabs = collectSyncableOpenTabs([a], { x: { tabs: [dup] } })
    expect(tabs).toHaveLength(1)
  })
})
