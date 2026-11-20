import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('./tauri', () => ({
  safeInvoke: invoke,
  isSshResource: (path: string) => path.startsWith('ssh://'),
}))

import {
  formatEntryCount,
  formatFileTime,
  getPropertiesLocation,
  loadFileProperties,
} from './fileProperties'

beforeEach(() => {
  invoke.mockReset()
})

describe('getPropertiesLocation', () => {
  it('returns parent directory for a file path', () => {
    expect(getPropertiesLocation(String.raw`D:\Work\demo\app.ts`)).toBe(String.raw`D:\Work\demo`)
    expect(getPropertiesLocation('/home/user/project/readme.md')).toBe('/home/user/project')
  })

  it('returns parent directory for a folder path', () => {
    expect(getPropertiesLocation(String.raw`D:\Work\demo`)).toBe(String.raw`D:\Work`)
    expect(getPropertiesLocation('/home/user/project')).toBe('/home/user')
  })

  it('drops the ssh connection id from a Windows OpenSSH parent', () => {
    expect(
      getPropertiesLocation('ssh://23a6efe9-51bb-4121-9d8c-41538a91d6b2/D:/code/qingcode/src/a.ts'),
    ).toBe('D:/code/qingcode/src')
  })
})

describe('loadFileProperties', () => {
  it('reads remote size, creation and modification time', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'file_stat') return { size: 42, is_dir: false }
      if (command === 'file_ctime') return 1_600_000_000_000
      if (command === 'file_mtime') return 1_700_000_000_000
      throw new Error(`unexpected ${command}`)
    })
    const path = 'ssh://conn/home/user/project/a.tar.gz'
    const properties = await loadFileProperties(path, 'a.tar.gz', false)
    expect(properties).toMatchObject({
      kind: 'file',
      size: 42,
      createdMs: 1_600_000_000_000,
      modifiedMs: 1_700_000_000_000,
      location: '/home/user/project',
    })
  })

  it('shows no creation time when the remote cannot provide one', async () => {
    invoke.mockImplementation(async (_action: string, command: string) => {
      if (command === 'file_stat') return { size: 1, is_dir: false }
      if (command === 'file_ctime') throw new Error('unsupported')
      if (command === 'file_mtime') return 1_700_000_000_000
      throw new Error(`unexpected ${command}`)
    })
    const properties = await loadFileProperties('ssh://conn/srv/a.txt', 'a.txt', false)
    expect(properties.createdMs).toBeNull()
  })
})

describe('formatEntryCount', () => {
  it('returns em dash when count is unavailable', () => {
    expect(formatEntryCount(null, 'en')).toBe('—')
    expect(formatEntryCount(undefined, 'zh-CN')).toBe('—')
  })

  it('formats a known count', () => {
    expect(formatEntryCount(1234, 'en')).toBe('1,234')
  })
})

describe('formatFileTime', () => {
  it('returns em dash when time is null', () => {
    expect(formatFileTime(null, 'en')).toBe('—')
  })

  it('formats a known timestamp', () => {
    const text = formatFileTime(Date.UTC(2024, 0, 15, 8, 30, 0), 'en')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toBe('—')
  })
})
