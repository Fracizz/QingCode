import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  openFile: vi.fn(),
  setView: vi.fn(),
  revealFileInTree: vi.fn(),
  pushToast: vi.fn(),
}))

vi.mock('../tauri', () => ({
  isTauri: () => true,
  safeInvoke: (...args: unknown[]) => mocks.safeInvoke(...args),
}))

vi.mock('../i18n', () => ({
  translate: (text: string) => text,
}))

vi.mock('../../store/editorStore', () => ({
  useEditorStore: {
    getState: () => ({ openFile: mocks.openFile }),
  },
}))

vi.mock('../../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      pushToast: mocks.pushToast,
      revealFileInTree: mocks.revealFileInTree,
    }),
  },
}))

vi.mock('../../store/uiStore', () => ({
  useUIStore: {
    getState: () => ({ setView: mocks.setView }),
  },
}))

import { canOpenGitPathInEditor, openWorkingTreeFile } from './openWorkingTreeFile'

describe('canOpenGitPathInEditor', () => {
  it('rejects deleted porcelain and name-status codes', () => {
    expect(canOpenGitPathInEditor('D')).toBe(false)
    expect(canOpenGitPathInEditor(' D')).toBe(false)
    expect(canOpenGitPathInEditor('D ')).toBe(false)
    expect(canOpenGitPathInEditor('MD')).toBe(false)
    expect(canOpenGitPathInEditor('M')).toBe(true)
    expect(canOpenGitPathInEditor(' M')).toBe(true)
    expect(canOpenGitPathInEditor('A')).toBe(true)
    expect(canOpenGitPathInEditor('??')).toBe(true)
  })
})

describe('openWorkingTreeFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openFile.mockResolvedValue(undefined)
    mocks.safeInvoke.mockResolvedValue({ size: 16, is_dir: false })
  })

  it('opens an existing file and switches to the explorer', async () => {
    await expect(
      openWorkingTreeFile({
        absolutePath: 'D:/repo/src/app.ts',
        line: 12,
        column: 3,
      })
    ).resolves.toBe('opened')

    expect(mocks.setView).toHaveBeenCalledWith('explorer')
    expect(mocks.openFile).toHaveBeenCalledWith('D:/repo/src/app.ts', 12, 3)
    expect(mocks.pushToast).not.toHaveBeenCalled()
  })

  it('opens SSH resources without treating them as local paths', async () => {
    await expect(
      openWorkingTreeFile({
        absolutePath: 'ssh://conn/home/code/app.py',
        status: 'M',
      })
    ).resolves.toBe('opened')

    expect(mocks.safeInvoke).toHaveBeenCalledWith('读取文件信息', 'file_stat', {
      path: 'ssh://conn/home/code/app.py',
    })
    expect(mocks.openFile).toHaveBeenCalledWith('ssh://conn/home/code/app.py', undefined, undefined)
  })

  it('toasts when Git says the path was deleted', async () => {
    await expect(
      openWorkingTreeFile({
        absolutePath: 'D:/repo/gone.ts',
        status: 'D',
      })
    ).resolves.toBe('missing')

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.setView).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('info', '工作区中不存在该文件')
  })

  it('toasts when the working-tree file is missing', async () => {
    mocks.safeInvoke.mockRejectedValue(new Error('not found'))

    await expect(
      openWorkingTreeFile({ absolutePath: 'D:/repo/missing.ts' })
    ).resolves.toBe('missing')

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('info', '工作区中不存在该文件')
  })

  it('reveals directories in the explorer instead of opening an editor tab', async () => {
    mocks.safeInvoke.mockResolvedValue({ size: 0, is_dir: true })

    await expect(
      openWorkingTreeFile({ absolutePath: 'D:/repo/src' })
    ).resolves.toBe('revealed-directory')

    expect(mocks.setView).toHaveBeenCalledWith('explorer')
    expect(mocks.revealFileInTree).toHaveBeenCalledWith('D:/repo/src', { force: true })
    expect(mocks.openFile).not.toHaveBeenCalled()
  })
})
