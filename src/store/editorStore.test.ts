import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab } from '../types'

vi.mock('../lib/draftRecovery', () => ({
  clearDraftForTab: vi.fn(),
}))

vi.mock('../lib/editorSession', () => ({
  disposeEditorSession: vi.fn(),
  disposeEditorSessions: vi.fn(),
  flushAllLiveEditorContents: vi.fn(),
  flushLiveEditorContent: vi.fn(),
  getLiveEditorContent: vi.fn(() => null),
}))

const safeInvoke = vi.fn()

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => safeInvoke(...args),
}))

vi.mock('./projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      pushToast: vi.fn(),
      revealFileInTree: vi.fn(),
      addRecentFile: vi.fn(),
      currentProject: null,
      projects: [],
    }),
  },
}))

import { useEditorStore } from './editorStore'

function makeTab(partial: Partial<EditorTab> & Pick<EditorTab, 'id' | 'path'>): EditorTab {
  return {
    name: partial.name ?? partial.path.split(/[/\\]/).pop() ?? partial.path,
    dirty: false,
    content: 'hello',
    language: 'typescript',
    viewMode: 'edit',
    ...partial,
  }
}

describe('editorStore tab lifecycle', () => {
  beforeEach(() => {
    safeInvoke.mockReset()
    useEditorStore.setState({
      tabs: [
        makeTab({ id: 'a', path: 'D:\\proj\\src\\a.ts', content: 'a', dirty: false }),
        makeTab({ id: 'b', path: 'D:\\proj\\src\\b.ts', content: 'b', dirty: true }),
      ],
      activeTabId: 'a',
      pendingReveal: null,
      projectSessions: {
        other: {
          tabs: [makeTab({ id: 'c', path: 'D:\\proj\\lib\\c.ts', content: 'c', dirty: false })],
          activeTabId: 'c',
          pendingReveal: null,
        },
      },
    })
  })

  it('markDirty / markClean toggle dirty on the target tab', () => {
    useEditorStore.getState().markDirty('a')
    expect(useEditorStore.getState().findTab('a')?.dirty).toBe(true)
    useEditorStore.getState().markClean('a')
    expect(useEditorStore.getState().findTab('a')?.dirty).toBe(false)
  })

  it('reloadFromDisk replaces content and clears dirty', async () => {
    useEditorStore.getState().markDirty('b')
    await useEditorStore.getState().reloadFromDisk('b', 'from-disk', 1234)
    const tab = useEditorStore.getState().findTab('b')
    expect(tab?.content).toBe('from-disk')
    expect(tab?.dirty).toBe(false)
    expect(tab?.diskMtime).toBe(1234)
    expect(tab?.contentEpoch).toBe(1)
  })

  it('renamePath updates visible and stashed tabs under the old path', () => {
    useEditorStore.getState().renamePath('D:\\proj\\src', 'D:\\proj\\app')
    expect(useEditorStore.getState().findTab('a')?.path).toBe('D:\\proj\\app\\a.ts')
    expect(useEditorStore.getState().findTab('a')?.name).toBe('a.ts')
    expect(useEditorStore.getState().findTab('b')?.path).toBe('D:\\proj\\app\\b.ts')
    expect(useEditorStore.getState().projectSessions.other.tabs[0]?.path).toBe(
      'D:\\proj\\lib\\c.ts',
    )

    useEditorStore.getState().renamePath('D:\\proj\\lib\\c.ts', 'D:\\proj\\lib\\renamed.ts')
    expect(useEditorStore.getState().projectSessions.other.tabs[0]?.path).toBe(
      'D:\\proj\\lib\\renamed.ts',
    )
    expect(useEditorStore.getState().projectSessions.other.tabs[0]?.name).toBe('renamed.ts')
  })

  it('setDiskMtime updates external-change baseline without clearing content', () => {
    useEditorStore.getState().setDiskMtime('a', 999)
    const tab = useEditorStore.getState().findTab('a')
    expect(tab?.diskMtime).toBe(999)
    expect(tab?.content).toBe('a')
    expect(tab?.dirty).toBe(false)
  })

  it('setTabEncoding marks the buffer dirty for an explicit save conversion', () => {
    useEditorStore.getState().setTabEncoding('a', 'gb18030')
    const tab = useEditorStore.getState().findTab('a')
    expect(tab?.encoding).toBe('gb18030')
    expect(tab?.dirty).toBe(true)
  })

  it('openFile rehydrates a session-restored tab that has no content yet', async () => {
    const path = 'D:\\proj\\src\\restored.ts'
    useEditorStore.setState({
      tabs: [makeTab({ id: 'restored', path, content: undefined })],
      activeTabId: 'restored',
      pendingReveal: null,
      projectSessions: {},
    })
    safeInvoke.mockImplementation(async (_label: string, cmd: string) => {
      if (cmd === 'file_stat') return { size: 5, is_dir: false }
      if (cmd === 'file_mtime') return 42
      if (cmd === 'read_file') return 'hello'
      return null
    })

    await useEditorStore.getState().openFile(path)

    const tab = useEditorStore.getState().findTab('restored')
    expect(tab?.content).toBe('hello')
    expect(tab?.loading).toBe(false)
    expect(tab?.diskMtime).toBe(42)
    expect(tab?.fileSize).toBe(5)
  })

  it('openFile does not re-read a plain tab that only cleared its Zustand buffer', async () => {
    const path = 'D:\\proj\\src\\big.log'
    useEditorStore.setState({
      tabs: [
        makeTab({
          id: 'plain',
          path,
          content: undefined,
          fileSize: 30 * 1024 * 1024,
          diskMtime: 7,
        }),
      ],
      activeTabId: null,
      pendingReveal: null,
      projectSessions: {},
    })

    await useEditorStore.getState().openFile(path)

    expect(safeInvoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().activeTabId).toBe('plain')
  })

  it('switches project sessions without losing dirty buffers or pinned settings', () => {
    const pinned = makeTab({
      id: 'settings',
      path: 'C:\\Users\\tester\\.qingcode\\default-settings.json',
      content: '{ /* settings */ }',
    })
    const dirty = makeTab({
      id: 'p1-dirty',
      path: 'D:\\project-one\\src\\draft.ts',
      content: 'unsaved change',
      dirty: true,
    })
    const incoming = makeTab({
      id: 'p2-file',
      path: 'D:\\project-two\\src\\index.ts',
      content: 'project two',
    })
    useEditorStore.setState({
      tabs: [dirty, pinned],
      activeTabId: dirty.id,
      pendingReveal: { path: dirty.path, line: 4 },
      projectSessions: {
        p2: {
          tabs: [incoming],
          activeTabId: incoming.id,
          pendingReveal: { path: incoming.path, line: 8 },
        },
      },
    })

    useEditorStore.getState().activateProjectSession('p1', 'p2')

    expect(useEditorStore.getState().tabs.map(tab => tab.id)).toEqual(['p2-file', 'settings'])
    expect(useEditorStore.getState().activeTabId).toBe('p2-file')
    expect(useEditorStore.getState().pendingReveal).toEqual({ path: incoming.path, line: 8 })
    expect(useEditorStore.getState().projectSessions.p1.tabs[0]).toMatchObject({
      id: 'p1-dirty',
      content: 'unsaved change',
      dirty: true,
    })

    useEditorStore.getState().activateProjectSession('p2', 'p1')

    expect(useEditorStore.getState().tabs.map(tab => tab.id)).toEqual(['p1-dirty', 'settings'])
    expect(useEditorStore.getState().findTab('p1-dirty')).toMatchObject({
      content: 'unsaved change',
      dirty: true,
    })
  })
})
