import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '@/types'
import {
  formatLocalAttachmentPaths,
  isSameTerminalSession,
  prepareTerminalAttachments,
  storeAttachmentFiles,
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
