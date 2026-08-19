// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushToast = vi.fn()
const copyToClipboard = vi.fn()
const findProjectForPath = vi.fn()
const formatFileReference = vi.fn()
const getEditorView = vi.fn()
const explorerPathsForCopyShortcut = vi.fn()

vi.mock('./i18n', () => ({
  translate: (key: string) => key,
}))

vi.mock('../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      pushToast,
      projects: [{ id: 'p1', name: 'App', path: 'D:/work/app' }],
      currentProject: { id: 'p1', name: 'App', path: 'D:/work/app' },
    }),
  },
}))

vi.mock('../store/editorStore', () => ({
  useEditorStore: {
    getState: () => ({
      tabs: [],
      activeTabId: null,
    }),
  },
}))

vi.mock('./editorSession', () => ({
  getEditorView: (...args: unknown[]) => getEditorView(...args),
}))

vi.mock('./explorerSelection', () => ({
  explorerPathsForCopyShortcut: (...args: unknown[]) => explorerPathsForCopyShortcut(...args),
}))

vi.mock('../utils/fileReferences', async () => {
  const actual = await vi.importActual<typeof import('../utils/fileReferences')>(
    '../utils/fileReferences',
  )
  return {
    ...actual,
    copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
    findProjectForPath: (...args: unknown[]) => findProjectForPath(...args),
    formatFileReference: (...args: unknown[]) => formatFileReference(...args),
  }
})

import {
  COPY_PATH_FOCUS_ATTR,
  copyActivePathAction,
  copyFileReferenceAction,
  copyPathAction,
  copyRelativePathAction,
} from './copyFileActions'

describe('copyFileActions', () => {
  beforeEach(() => {
    pushToast.mockReset()
    copyToClipboard.mockReset()
    findProjectForPath.mockReset()
    formatFileReference.mockReset()
    getEditorView.mockReset()
    explorerPathsForCopyShortcut.mockReset()
    explorerPathsForCopyShortcut.mockReturnValue([])
    document.body.innerHTML = ''
    copyToClipboard.mockResolvedValue(undefined)
    findProjectForPath.mockReturnValue({ id: 'p1', name: 'App', path: 'D:/work/app' })
    formatFileReference.mockReturnValue('@App/src/a.ts#L1')
  })

  it('copyPathAction writes the path and toasts success', async () => {
    await copyPathAction('D:/work/app/src/a.ts')
    expect(copyToClipboard).toHaveBeenCalledWith('D:/work/app/src/a.ts')
    expect(pushToast).toHaveBeenCalledWith('success', '路径已复制')
  })

  it('copyPathAction joins multiple paths with newlines', async () => {
    await copyPathAction(['D:/work/app/a.svg', 'D:/work/app/b.svg', 'D:/work/app/c.html'])
    expect(copyToClipboard).toHaveBeenCalledWith(
      'D:/work/app/a.svg\nD:/work/app/b.svg\nD:/work/app/c.html',
    )
    expect(pushToast).toHaveBeenCalledWith('success', '已复制 {count} 个路径')
  })

  it('copyRelativePathAction joins multiple relative paths', async () => {
    await copyRelativePathAction(['D:/work/app/a.svg', 'D:/work/app/b.svg'])
    expect(copyToClipboard).toHaveBeenCalledWith('a.svg\nb.svg')
    expect(pushToast).toHaveBeenCalledWith('success', '已复制 {count} 个相对路径')
  })

  it('copyFileReferenceAction formats with explicit line range (explorer)', async () => {
    await copyFileReferenceAction('D:/work/app/src/a.ts', { startLine: 1 })
    expect(formatFileReference).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'App' }),
      'D:/work/app/src/a.ts',
      1,
      1,
    )
    expect(copyToClipboard).toHaveBeenCalledWith('@App/src/a.ts#L1')
    expect(pushToast).toHaveBeenCalledWith('success', '文件引用已复制')
  })

  it('copyActivePathAction copies all focused explorer selections', async () => {
    explorerPathsForCopyShortcut.mockReturnValue([
      'D:/work/app/a.svg',
      'D:/work/app/b.svg',
    ])
    await copyActivePathAction()
    expect(copyToClipboard).toHaveBeenCalledWith('D:/work/app/a.svg\nD:/work/app/b.svg')
    expect(pushToast).toHaveBeenCalledWith('success', '已复制 {count} 个路径')
  })

  it('copyActivePathAction prefers a focused project chip path', async () => {
    const chip = document.createElement('div')
    chip.tabIndex = 0
    chip.setAttribute(COPY_PATH_FOCUS_ATTR, 'D:/work/project-selected')
    document.body.appendChild(chip)
    chip.focus()

    await copyActivePathAction()

    expect(copyToClipboard).toHaveBeenCalledWith('D:/work/project-selected')
    expect(explorerPathsForCopyShortcut).not.toHaveBeenCalled()
  })
})
