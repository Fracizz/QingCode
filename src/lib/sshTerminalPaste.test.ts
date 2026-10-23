import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const toasts: { id: string; kind: string; text: string }[] = []
  return {
    authorizePaths: vi.fn(),
    safeInvoke: vi.fn(),
    startSshTransfer: vi.fn(),
    toasts,
    pushToast: vi.fn((kind: string, text: string) => {
      toasts.push({ id: String(toasts.length + 1), kind, text })
    }),
    dismissToast: vi.fn((id: string) => {
      const index = toasts.findIndex(toast => toast.id === id)
      if (index >= 0) toasts.splice(index, 1)
    }),
  }
})

vi.mock('./pathAllowlist', () => ({ authorizePaths: mocks.authorizePaths }))
vi.mock('./tauri', () => ({
  isSshResource: (value: unknown) => typeof value === 'string' && value.startsWith('ssh://'),
  isTauri: () => true,
  safeInvoke: mocks.safeInvoke,
}))
vi.mock('./sshTransfer', () => ({ startSshTransfer: mocks.startSshTransfer }))
vi.mock('../store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      pushToast: mocks.pushToast,
      dismissToast: mocks.dismissToast,
      toasts: mocks.toasts,
      projects: [],
      refreshProjectTree: vi.fn(),
    }),
  },
}))
vi.mock('../store/confirmStore', () => ({ confirmDialog: vi.fn() }))

import { confirmDialog } from '../store/confirmStore'
import {
  formatRemotePasteText,
  isLocalAbsolutePath,
  parseLocalFilePasteText,
  quotePosixShellPath,
  quotePowerShellPath,
  remoteShellPathFromUri,
  sshTerminalPasteRoot,
  SSH_TERMINAL_PASTE_MAX_BYTES,
  uploadLocalFilesForSshTerminal,
  pasteLocalFilesIntoSshTerminal,
  clearSshTerminalPasteUploads,
  confirmClearSshTerminalPasteUploads,
} from './sshTerminalPaste'

describe('isLocalAbsolutePath', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts Windows drive and UNC paths', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })
    expect(isLocalAbsolutePath('D:\\code\\app.ts')).toBe(true)
    expect(isLocalAbsolutePath('C:/temp/a.txt')).toBe(true)
    expect(isLocalAbsolutePath('\\\\server\\share\\a.txt')).toBe(true)
    expect(isLocalAbsolutePath('/home/owner/a.txt')).toBe(false)
    expect(isLocalAbsolutePath('ssh://c1/home/a.txt')).toBe(false)
  })

  it('accepts POSIX absolute paths on non-Windows hosts', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })
    expect(isLocalAbsolutePath('/Users/me/a.txt')).toBe(true)
  })
})

describe('parseLocalFilePasteText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads quoted Explorer / Windows Terminal file lists', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })
    expect(parseLocalFilePasteText('"D:\\docs\\a.txt"\r\n"D:\\docs\\b.txt"')).toEqual([
      'D:\\docs\\a.txt',
      'D:\\docs\\b.txt',
    ])
  })

  it('does not rewrite mixed command text', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })
    expect(parseLocalFilePasteText('python D:\\docs\\a.txt')).toBeNull()
    expect(parseLocalFilePasteText('hello')).toBeNull()
  })
})

describe('remote shell quoting', () => {
  it('quotes POSIX paths and escapes single quotes', () => {
    expect(quotePosixShellPath(`/tmp/a b.txt`)).toBe(`'/tmp/a b.txt'`)
    expect(quotePosixShellPath(`/tmp/o'reilly.txt`)).toBe(`'/tmp/o'\\''reilly.txt'`)
  })

  it('quotes PowerShell paths and doubles single quotes', () => {
    expect(quotePowerShellPath(`D:\\docs\\a b.txt`)).toBe(`'D:\\docs\\a b.txt'`)
    expect(quotePowerShellPath(`D:\\o'reilly.txt`)).toBe(`'D:\\o''reilly.txt'`)
  })

  it('converts Windows OpenSSH URIs to drive-letter paths', () => {
    expect(
      remoteShellPathFromUri(
        'ssh://c1/D:/code/app',
        'ssh://c1/D:/code/app/.qingcode/terminal-paste/x/a.txt',
      ),
    ).toBe('D:\\code\\app\\.qingcode\\terminal-paste\\x\\a.txt')
    expect(
      remoteShellPathFromUri(
        'ssh://c1/home/owner/app',
        'ssh://c1/home/owner/app/.qingcode/terminal-paste/x/a.txt',
      ),
    ).toBe('/home/owner/app/.qingcode/terminal-paste/x/a.txt')
  })

  it('joins quoted remote paths for paste', () => {
    expect(
      formatRemotePasteText('ssh://c1/home/owner/app', [
        'ssh://c1/home/owner/app/.qingcode/terminal-paste/x/a.txt',
      ]),
    ).toBe(`'/home/owner/app/.qingcode/terminal-paste/x/a.txt'`)
  })
})

describe('uploadLocalFilesForSshTerminal', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uploads into .qingcode/terminal-paste and returns a remote path', async () => {
    mocks.safeInvoke.mockImplementation(async (_action: string, command: string, args: { parent?: string; name?: string; path?: string }) => {
      if (command === 'file_stat') return { size: 12, is_dir: false }
      if (command === 'validate_directory') throw new Error('missing')
      if (command === 'create_directory') return `${args.parent}/${args.name}`
      return undefined
    })
    mocks.startSshTransfer.mockResolvedValue({ status: 'completed' })

    const pasted = await uploadLocalFilesForSshTerminal('ssh://c1/home/owner/app', [
      'D:\\docs\\note.txt',
    ])

    expect(mocks.startSshTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'upload',
        paths: ['D:\\docs\\note.txt'],
      }),
    )
    const destination = mocks.startSshTransfer.mock.calls[0][0].destination as string
    expect(destination).toMatch(/^ssh:\/\/c1\/home\/owner\/app\/\.qingcode\/terminal-paste\//)
    expect(pasted).toBe(`'${destination.replace(/^ssh:\/\/c1/, '')}/note.txt'`)
  })

  it('rejects a file over 100MB before creating a remote directory', async () => {
    mocks.safeInvoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'file_stat') {
        return { size: SSH_TERMINAL_PASTE_MAX_BYTES + 1, is_dir: false }
      }
      return undefined
    })

    await expect(
      uploadLocalFilesForSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\huge.bin']),
    ).rejects.toThrow('huge.bin')
    expect(mocks.startSshTransfer).not.toHaveBeenCalled()
    expect(mocks.safeInvoke).not.toHaveBeenCalledWith(
      '创建远程目录',
      'create_directory',
      expect.anything(),
    )
  })

  it('allows a file of exactly 100MB', async () => {
    mocks.safeInvoke.mockImplementation(async (_action: string, command: string, args: { parent?: string; name?: string }) => {
      if (command === 'file_stat') return { size: SSH_TERMINAL_PASTE_MAX_BYTES, is_dir: false }
      if (command === 'validate_directory') throw new Error('missing')
      if (command === 'create_directory') return `${args.parent}/${args.name}`
      return undefined
    })
    mocks.startSshTransfer.mockResolvedValue({ status: 'completed' })

    await expect(
      uploadLocalFilesForSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\edge.bin']),
    ).resolves.toEqual(expect.any(String))
    expect(mocks.startSshTransfer).toHaveBeenCalled()
  })

  it('rejects a folder whose files total more than 100MB', async () => {
    mocks.safeInvoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'file_stat') return { size: 0, is_dir: true }
      if (command === 'directory_entry_counts') {
        return { totalSize: SSH_TERMINAL_PASTE_MAX_BYTES + 1 }
      }
      return undefined
    })

    await expect(
      uploadLocalFilesForSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\payload']),
    ).rejects.toThrow('payload')
    expect(mocks.startSshTransfer).not.toHaveBeenCalled()
  })
})

describe('pasteLocalFilesIntoSshTerminal', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mocks.toasts.splice(0)
  })

  function stubDirectories() {
    mocks.safeInvoke.mockImplementation(async (_action: string, command: string, args: { parent?: string; name?: string }) => {
      if (command === 'file_stat') return { size: 12, is_dir: false }
      if (command === 'validate_directory') throw new Error('missing')
      if (command === 'create_directory') return `${args.parent}/${args.name}`
      return undefined
    })
  }

  it('shows only the success toast when the upload finishes immediately', async () => {
    vi.useFakeTimers()
    stubDirectories()
    mocks.startSshTransfer.mockResolvedValue({ status: 'completed' })
    const text = await pasteLocalFilesIntoSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\note.txt'])
    expect(text).toContain('note.txt')
    expect(mocks.pushToast.mock.calls.map(call => call[0])).toEqual(['success'])
  })

  it('replaces the uploading toast after a slow upload', async () => {
    vi.useFakeTimers()
    stubDirectories()
    mocks.startSshTransfer.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ status: 'completed' }), 800)),
    )
    const pending = pasteLocalFilesIntoSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\note.txt'])
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.pushToast.mock.calls.map(call => call[0])).toEqual(['info'])
    await vi.advanceTimersByTimeAsync(400)
    await pending
    expect(mocks.pushToast.mock.calls.map(call => call[0])).toEqual(['info', 'success'])
    expect(mocks.toasts.map(toast => toast.kind)).toEqual(['success'])
  })

  it('keeps the uploading toast until the last concurrent paste finishes', async () => {
    vi.useFakeTimers()
    stubDirectories()
    mocks.startSshTransfer
      .mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve({ status: 'completed' }), 1600)),
      )
      .mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve({ status: 'completed' }), 800)),
      )
    const slow = pasteLocalFilesIntoSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\a.txt'])
    const fast = pasteLocalFilesIntoSshTerminal('ssh://c1/home/owner/app', ['D:\\docs\\b.txt'])
    await vi.advanceTimersByTimeAsync(400)
    expect(mocks.toasts.some(toast => toast.kind === 'info')).toBe(true)

    await vi.advanceTimersByTimeAsync(400)
    await fast
    // 先完成的那次不能把仍在上传的进度提示关掉。
    expect(mocks.toasts.some(toast => toast.kind === 'info')).toBe(true)

    await vi.advanceTimersByTimeAsync(800)
    await slow
    expect(mocks.toasts.some(toast => toast.kind === 'info')).toBe(false)
  })
})

describe('sshTerminalPasteRoot', () => {
  it('joins onto the SSH project .qingcode directory', () => {
    expect(sshTerminalPasteRoot('ssh://c1/home/owner/app')).toBe(
      'ssh://c1/home/owner/app/.qingcode/terminal-paste',
    )
  })
})

describe('clearSshTerminalPasteUploads', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('deletes the paste directory when it exists', async () => {
    mocks.safeInvoke.mockResolvedValue(undefined)
    await expect(clearSshTerminalPasteUploads('ssh://c1/home/owner/app')).resolves.toBe('cleared')
    expect(mocks.safeInvoke).toHaveBeenCalledWith('删除', 'delete_path', {
      path: 'ssh://c1/home/owner/app/.qingcode/terminal-paste',
    })
  })

  it('returns missing when the paste directory is absent', async () => {
    mocks.safeInvoke.mockRejectedValue(new Error('missing'))
    await expect(clearSshTerminalPasteUploads('ssh://c1/home/owner/app')).resolves.toBe('missing')
  })
})

describe('confirmClearSshTerminalPasteUploads', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not delete when the user cancels', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false)
    await confirmClearSshTerminalPasteUploads('ssh://c1/home/owner/app')
    expect(mocks.safeInvoke).not.toHaveBeenCalled()
  })

  it('deletes after confirm and toasts success', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true)
    mocks.safeInvoke.mockResolvedValue(undefined)
    await confirmClearSshTerminalPasteUploads('ssh://c1/home/owner/app')
    expect(mocks.safeInvoke).toHaveBeenCalledWith('删除', 'delete_path', {
      path: 'ssh://c1/home/owner/app/.qingcode/terminal-paste',
    })
    expect(mocks.pushToast).toHaveBeenCalledWith('success', expect.any(String))
  })
})
