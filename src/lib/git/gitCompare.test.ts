import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorTab } from '@/types'

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  flushLiveEditorContent: vi.fn(),
  getLiveEditorContent: vi.fn(),
  openCompare: vi.fn(),
  closeCompare: vi.fn(),
  pushToast: vi.fn(),
  editorState: {
    tabs: [] as EditorTab[],
    projectSessions: {} as Record<string, { tabs: EditorTab[] }>,
  },
}))

vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => mocks.safeInvoke(...args),
}))

vi.mock('@/lib/editorSession', () => ({
  flushLiveEditorContent: mocks.flushLiveEditorContent,
  getLiveEditorContent: mocks.getLiveEditorContent,
}))

vi.mock('@/lib/editorSettings', () => ({
  getEditorPreferences: () => ({ encoding: 'utf8' }),
}))

vi.mock('@/lib/fileEncoding', () => ({
  resolveReadEncoding: vi.fn(async () => 'utf8'),
}))

vi.mock('@/lib/i18n', () => ({
  translate: (text: string) => text,
}))

vi.mock('@/store/compareStore', () => ({
  useCompareStore: {
    getState: () => ({
      openCompare: mocks.openCompare,
      closeCompare: mocks.closeCompare,
    }),
  },
}))

vi.mock('@/store/editorStore', () => ({
  useEditorStore: {
    getState: () => mocks.editorState,
  },
}))

vi.mock('@/store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ pushToast: mocks.pushToast }),
  },
}))

import { openGitCompareWithHead } from '@/lib/git/gitCompare'

function openTab(partial: Partial<EditorTab> = {}): EditorTab {
  return {
    id: 'tab',
    path: 'D:\\project\\src\\app.ts',
    name: 'app.ts',
    content: 'zustand copy',
    dirty: true,
    viewMode: 'edit',
    ...partial,
  }
}

describe('Git compare journey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.editorState.tabs = [openTab()]
    mocks.editorState.projectSessions = {}
    mocks.getLiveEditorContent.mockReturnValue('live unsaved buffer')
  })

  it('compares the live unsaved buffer against Git HEAD', async () => {
    mocks.safeInvoke.mockResolvedValue('HEAD content')

    await openGitCompareWithHead('D:/project/src/app.ts')

    expect(mocks.flushLiveEditorContent).toHaveBeenCalledWith('tab')
    expect(mocks.safeInvoke).toHaveBeenCalledTimes(1)
    expect(mocks.safeInvoke).toHaveBeenCalledWith(
      '读取 Git HEAD 文件',
      'git_show_head_file',
      { path: 'D:/project/src/app.ts' },
    )
    expect(mocks.openCompare).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'D:/project/src/app.ts',
        leftContent: 'live unsaved buffer',
        rightContent: 'HEAD content',
        leftTitle: '工作区版本',
        rightTitle: 'Git HEAD',
      }),
    )
  })

  it('reports a new file without opening an empty comparison', async () => {
    mocks.safeInvoke.mockResolvedValue(null)

    await openGitCompareWithHead('D:/project/src/app.ts')

    expect(mocks.openCompare).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith(
      'info',
      '该文件不在 Git HEAD 中（可能是新文件）',
    )
  })
})
