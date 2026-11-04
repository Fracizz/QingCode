import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('./tauri', () => ({
  safeInvoke: invoke,
  isSshResource: (path: string) => path.startsWith('ssh://'),
}))

import { findLineOffset, getFileStat, readFileSlice, scanDirectoryEntries } from './fileIpc'

beforeEach(() => {
  invoke.mockReset()
})

describe('typed file IPC', () => {
  it('keeps local slices in their native shape', async () => {
    const slice = { offset: 3, len: 6, text: '你好', eof: false, file_size: 50 }
    invoke.mockResolvedValue(slice)
    expect(await readFileSlice({ path: '/project/file', offset: 3, maxBytes: 6 })).toBe(slice)
    expect(invoke).toHaveBeenCalledWith('读取文件片段', 'read_file_slice', {
      path: '/project/file', offset: 3, maxBytes: 6,
    })
  })

  it('normalizes SSH wire fields using byte offsets, not JS string length', async () => {
    invoke.mockResolvedValue({
      content: '你好', offset: 3, nextOffset: 9, fileSize: 50, eof: false,
    })
    expect(await readFileSlice({ path: 'ssh://host/project/file', offset: 3, maxBytes: 6 }))
      .toEqual({ offset: 3, len: 6, text: '你好', eof: false, file_size: 50 })
    expect(invoke.mock.calls[0][1]).toBe('read_file_slice')
  })

  it('preserves backend errors without retrying on a different filesystem', async () => {
    const error = new Error('项目范围外')
    invoke.mockRejectedValue(error)
    await expect(readFileSlice({ path: 'ssh://host/outside', offset: 0, maxBytes: 12 }))
      .rejects.toBe(error)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('sets explicit scan options and leaves stat and line lookup responses intact', async () => {
    invoke.mockResolvedValue([])
    await scanDirectoryEntries({ path: '/project' })
    expect(invoke).toHaveBeenLastCalledWith('读取目录', 'scan_directory', {
      path: '/project', workspaceRoot: '/project', excludePatterns: null, excludeGitIgnore: false,
    })
    const stat = { size: 9, is_dir: false }
    invoke.mockResolvedValue(stat)
    expect(await getFileStat({ path: '/project/file' })).toBe(stat)
    const result = { line: 3, offset: 9, found: true, total_lines: 3, file_size: 12 }
    invoke.mockResolvedValue(result)
    expect(await findLineOffset({ path: '/project/file', line: 3 })).toBe(result)
  })
})
