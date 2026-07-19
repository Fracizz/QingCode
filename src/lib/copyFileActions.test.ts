import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushToast = vi.fn()
const copyToClipboard = vi.fn()
const findProjectForPath = vi.fn()
const formatFileReference = vi.fn()
const getEditorView = vi.fn()

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

import { copyFileReferenceAction, copyPathAction } from './copyFileActions'

describe('copyFileActions', () => {
  beforeEach(() => {
    pushToast.mockReset()
    copyToClipboard.mockReset()
    findProjectForPath.mockReset()
    formatFileReference.mockReset()
    getEditorView.mockReset()
    copyToClipboard.mockResolvedValue(undefined)
    findProjectForPath.mockReturnValue({ id: 'p1', name: 'App', path: 'D:/work/app' })
    formatFileReference.mockReturnValue('@App/src/a.ts#L1')
  })

  it('copyPathAction writes the path and toasts success', async () => {
    await copyPathAction('D:/work/app/src/a.ts')
    expect(copyToClipboard).toHaveBeenCalledWith('D:/work/app/src/a.ts')
    expect(pushToast).toHaveBeenCalledWith('success', '路径已复制')
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
})
