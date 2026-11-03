import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '@/types'
import {
  formatLocalAttachmentPaths,
  isSameTerminalSession,
  prepareTerminalAttachments,
  storeAttachmentFiles,
  terminalClipboardPaths,
} from './terminalAttachments'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), authorize: vi.fn(), upload: vi.fn() }))
vi.mock('../tauri', () => ({
  isTauri: () => true,
  isSshResource: (value: string) => value.startsWith('ssh://'),
  safeInvoke: mocks.invoke,
}))
vi.mock('../pathAllowlist', () => ({ authorizePaths: mocks.authorize }))
vi.mock('../sshTerminalPaste', async importOriginal => ({
  ...(await importOriginal<typeof import('../sshTerminalPaste')>()),
  pasteLocalFilesIntoSshTerminal: mocks.upload,
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('terminal attachment targets', () => {
  it.each([
    'D:/code/django',
    'D:\\code\\django',
    '"D:/code/django"',
    '\\\\server\\share\\django',
    '/home/me/django',
    'file:///D:/code/django',
    'D:/code/django\r\nD:/code/QingCode',
  ])('keeps path text out of attachment discovery: %s', async text => {
    mocks.invoke.mockImplementation(async (_action, command) => {
      if (command === 'clipboard_read_files') return []
      if (command === 'file_stat') return { is_dir: true, size: 0 }
      throw new Error(`Unexpected command: ${command}`)
    })
    const readText = vi.fn(async () => text)
    vi.stubGlobal('navigator', { clipboard: { readText } })

    expect(await terminalClipboardPaths({
      clipboardData: { files: [], getData: () => text },
    } as unknown as ClipboardEvent)).toEqual([])
    expect(await terminalClipboardPaths()).toEqual([])
    expect(mocks.invoke.mock.calls.every(([, command]) => command === 'clipboard_read_files')).toBe(true)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
  })

  it('keeps actual native file lists even when the event also contains path text', async () => {
    mocks.invoke.mockResolvedValue(['D:/code/django'])
    expect(await terminalClipboardPaths({
      clipboardData: { files: [], getData: () => 'D:/code/django' },
    } as unknown as ClipboardEvent)).toEqual(['D:/code/django'])
  })

  it('uses native screenshot paths without encoding browser file bytes', async () => {
    mocks.invoke.mockResolvedValue(['/tmp/screenshot.png'])
    const file = new File(['png'], 'screenshot.png', { type: 'image/png' })
    expect(await terminalClipboardPaths({
      clipboardData: { files: [file] },
    } as unknown as ClipboardEvent)).toEqual(['/tmp/screenshot.png'])
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('stores browser files when the native clipboard has no file or image', async () => {
    mocks.invoke.mockImplementation(async (_action, command) =>
      command === 'clipboard_read_files' ? [] : '/tmp/private/a.txt'
    )
    const file = { name: 'a.txt', size: 1, arrayBuffer: async () => Uint8Array.of(65).buffer } as File
    expect(await terminalClipboardPaths({
      clipboardData: { files: [file] },
    } as unknown as ClipboardEvent)).toEqual(['/tmp/private/a.txt'])
    expect(mocks.invoke).toHaveBeenCalledWith('保存终端附件', 'clipboard_store_file', {
      name: 'a.txt', bytes: [65],
    })
  })

  it('treats Linux/WSL as POSIX, independent of the frontend host', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    expect(
      formatLocalAttachmentPaths(
        { cwd: '/home/app', runEnvironment: { os: 'linux', kind: 'local' } },
        ["/tmp/截图 o'reilly.png"]
      )
    ).toBe("'/tmp/截图 o'\\''reilly.png'")
    expect(formatLocalAttachmentPaths({ cwd: '/home/app', shell: 'wsl' }, ['/tmp/a b.png'])).toBe(
      "'/tmp/a b.png'"
    )
    expect(
      formatLocalAttachmentPaths({ cwd: 'C:/app', resolvedShell: 'pwsh' }, ["C:\\a b\\it's.png"])
    ).toBe("'C:\\a b\\it''s.png'")
  })

  it('keeps SSH uploads on the existing remote transfer path', async () => {
    mocks.upload.mockResolvedValue("'/home/app/.qingcode/terminal-paste/a.png'")
    expect(
      await prepareTerminalAttachments({ cwd: 'ssh://c1/home/app' }, ['/tmp/a.png'])
    ).toContain('/home/app/')
    expect(mocks.upload).toHaveBeenCalledWith('ssh://c1/home/app', ['/tmp/a.png'])
  })

  it('preserves attachment bytes, including NUL and non-UTF8 bytes', async () => {
    mocks.invoke.mockResolvedValue('/tmp/private/a.png')
    const file = {
      name: 'a.png',
      type: 'image/png',
      size: 4,
      arrayBuffer: async () => Uint8Array.of(0, 255, 10, 128).buffer,
    } as File
    expect(await storeAttachmentFiles([file])).toEqual(['/tmp/private/a.png'])
    expect(mocks.invoke).toHaveBeenCalledWith('保存终端附件', 'clipboard_store_file', {
      name: 'a.png',
      bytes: [0, 255, 10, 128],
    })
  })

  it('rejects a restarted, removed, reconnecting or pending destination', () => {
    const tab = {
      id: 't1',
      cwd: '/app',
      startedAt: 1,
      ptyId: 'p1',
      status: 'running',
    } as TerminalTab
    expect(isSameTerminalSession(tab, { ...tab })).toBe(true)
    for (const target of [
      undefined,
      { ...tab, startedAt: 2 },
      { ...tab, ptyId: 'p2' },
      { ...tab, status: 'reconnecting' as const },
      { ...tab, ptySpawnPending: true },
    ]) {
      expect(isSameTerminalSession(tab, target)).toBe(false)
    }
  })
})
