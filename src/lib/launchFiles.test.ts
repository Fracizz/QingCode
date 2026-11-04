import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openLaunchFiles } from './launchFiles'

const mocks = vi.hoisted(() => ({
  safeInvoke: vi.fn(),
  authorizePaths: vi.fn(),
  openFile: vi.fn(),
  pushToast: vi.fn(),
}))

vi.mock('./tauri', () => ({
  isTauri: () => true,
  safeInvoke: mocks.safeInvoke,
}))
vi.mock('./pathAllowlist', () => ({ authorizePaths: mocks.authorizePaths }))
vi.mock('../store/editorStore', () => ({
  useEditorStore: { getState: () => ({ openFile: mocks.openFile }) },
}))
vi.mock('../store/projectStore', () => ({
  useProjectStore: { getState: () => ({ pushToast: mocks.pushToast }) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.safeInvoke.mockResolvedValue([])
  mocks.authorizePaths.mockResolvedValue(undefined)
  mocks.openFile.mockResolvedValue(undefined)
})

describe('openLaunchFiles', () => {
  it('drains the current window queue, authorizes paths, then opens line targets', async () => {
    mocks.safeInvoke.mockResolvedValue(['D:\\docs\\README.md:12:3'])

    await openLaunchFiles()

    expect(mocks.safeInvoke).toHaveBeenCalledWith('打开启动文件', 'take_launch_files')
    expect(mocks.authorizePaths).toHaveBeenCalledWith(['D:\\docs\\README.md'])
    expect(mocks.openFile).toHaveBeenCalledWith('D:\\docs\\README.md', 12, 3)
    expect(mocks.authorizePaths.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openFile.mock.invocationCallOrder[0],
    )
  })

  it('shows an error when authorization fails', async () => {
    mocks.safeInvoke.mockResolvedValue(['D:\\docs\\README.md'])
    mocks.authorizePaths.mockRejectedValue(new Error('denied'))

    await openLaunchFiles()

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('denied'),
    )
  })
})
