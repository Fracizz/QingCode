import { describe, expect, it } from 'vitest'
import { formatEntryCount, formatFileTime, getPropertiesLocation } from './fileProperties'

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
