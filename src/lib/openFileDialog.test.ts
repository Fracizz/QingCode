import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openFileFromDialog } from './openFileDialog'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  getOpenWithStatus: vi.fn(),
  authorizePaths: vi.fn(),
  openFile: vi.fn(),
  pushToast: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('./openWithSettings', () => ({ getOpenWithStatus: mocks.getOpenWithStatus }))
vi.mock('./pathAllowlist', () => ({ authorizePaths: mocks.authorizePaths }))
vi.mock('./tauri', () => ({ isTauri: mocks.isTauri }))
vi.mock('./i18n', () => ({
  translate: (key: string, values?: Record<string, string>) =>
    values?.error ? key.replace('{error}', values.error) : key,
}))
vi.mock('../store/editorStore', () => ({
  useEditorStore: { getState: () => ({ openFile: mocks.openFile }) },
}))
vi.mock('../store/projectStore', () => ({
  useProjectStore: { getState: () => ({ pushToast: mocks.pushToast }) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isTauri.mockReturnValue(true)
  mocks.getOpenWithStatus.mockResolvedValue({
    registered: false,
    exe_path: 'D:/QingCode.exe',
    extensions: ['txt', 'ts', 'md'],
    supported: true,
  })
  mocks.open.mockResolvedValue('D:/outside/example.ts')
  mocks.authorizePaths.mockResolvedValue(undefined)
  mocks.openFile.mockResolvedValue(undefined)
})

describe('openFileFromDialog', () => {
  it('selects one common file, authorizes it, then opens it', async () => {
    const calls: string[] = []
    mocks.authorizePaths.mockImplementation(async () => {
      calls.push('authorize')
    })
    mocks.openFile.mockImplementation(async () => {
      calls.push('open')
    })

    await openFileFromDialog()

    expect(mocks.open).toHaveBeenCalledWith({
      title: '打开文件',
      directory: false,
      multiple: false,
      filters: [
        { name: '代码和文本文件', extensions: ['txt', 'ts', 'md'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    expect(mocks.authorizePaths).toHaveBeenCalledWith(['D:/outside/example.ts'])
    expect(mocks.openFile).toHaveBeenCalledWith('D:/outside/example.ts')
    expect(calls).toEqual(['authorize', 'open'])
  })

  it('does nothing when selection is cancelled', async () => {
    mocks.open.mockResolvedValue(null)

    await openFileFromDialog()

    expect(mocks.authorizePaths).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.pushToast).not.toHaveBeenCalled()
  })

  it('falls back to the all-files filter when extension lookup fails', async () => {
    mocks.getOpenWithStatus.mockRejectedValue(new Error('status unavailable'))

    await openFileFromDialog()

    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ name: '所有文件', extensions: ['*'] }],
      })
    )
    expect(mocks.openFile).toHaveBeenCalledOnce()
  })

  it('reports authorization failures without opening the file', async () => {
    mocks.authorizePaths.mockRejectedValue(new Error('denied'))

    await openFileFromDialog()

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('error', '打开文件失败: Error: denied')
  })

  it('reports that browser preview cannot open local files', async () => {
    mocks.isTauri.mockReturnValue(false)

    await openFileFromDialog()

    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.pushToast).toHaveBeenCalledWith('error', '当前环境无法打开文件')
  })
})
