import { describe, expect, it } from 'vitest'
import {
  dedupePaths,
  isPathInside,
  looksWindowsPath,
  normalizePathForCompare,
  pickPathImpl,
  stripLongPathPrefix,
} from './paths'

describe('Windows 路径归一', () => {
  it('识别盘符、UNC、长路径前缀与反斜杠', () => {
    expect(looksWindowsPath('C:\\Repo\\a.ts')).toBe(true)
    expect(looksWindowsPath('c:/repo/a.ts')).toBe(true)
    expect(looksWindowsPath('\\\\server\\share\\a.ts')).toBe(true)
    expect(looksWindowsPath('\\\\?\\C:\\Repo\\a.ts')).toBe(true)
    expect(looksWindowsPath('/home/u/a.ts')).toBe(false)
  })

  it('长路径前缀还原成盘符或 UNC', () => {
    expect(stripLongPathPrefix('\\\\?\\C:\\Repo\\a.ts')).toBe('C:\\Repo\\a.ts')
    expect(stripLongPathPrefix('\\\\?\\UNC\\server\\share\\a.ts')).toBe(
      '\\\\server\\share\\a.ts',
    )
    expect(stripLongPathPrefix('\\\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts')
    expect(stripLongPathPrefix('/home/u/a.ts')).toBe('/home/u/a.ts')
  })

  it('斜杠、尾斜杠、盘符大小写与 UNC 前缀统一', () => {
    expect(normalizePathForCompare('C:\\Users\\A\\', 'win32')).toBe('c:/users/a')
    expect(normalizePathForCompare('c:/users/a', 'win32')).toBe('c:/users/a')
    expect(normalizePathForCompare('\\\\?\\C:\\', 'win32')).toBe('c:')
    expect(normalizePathForCompare('c:/', 'win32')).toBe('c:')
    expect(normalizePathForCompare('\\\\server\\share\\', 'win32')).toBe('//server/share')
    expect(normalizePathForCompare('\\\\?\\UNC\\server\\share', 'win32')).toBe('//server/share')
    expect(normalizePathForCompare('/', 'linux')).toBe('')
    expect(normalizePathForCompare('/Tmp/A', 'linux')).toBe('/Tmp/A')
    // Windows 风格路径即使宿主是 POSIX 也按大小写不敏感处理。
    expect(normalizePathForCompare('C:\\Users\\A', 'linux')).toBe('c:/users/a')
  })

  it('保留第一次出现的原字符串并按 Windows 语义去重', () => {
    expect(
      dedupePaths(['C:\\A\\x.ts', 'c:/a/x.ts', 'C:/A/Y.TS', '/tmp/a'], 'win32'),
    ).toEqual(['C:\\A\\x.ts', 'C:/A/Y.TS', '/tmp/a'])
    expect(dedupePaths(['/A/x', '/a/x'], 'linux')).toEqual(['/A/x', '/a/x'])
  })

  it('父子目录判断大小写不敏感', () => {
    expect(isPathInside('C:\\Repo', 'c:\\repo\\src', 'win32')).toBe(true)
    expect(isPathInside('C:\\Repo', 'C:\\Repo', 'win32')).toBe(false)
    expect(isPathInside('C:\\Repo', 'C:\\Repository\\a', 'win32')).toBe(false)
    expect(isPathInside('\\\\server\\share', '\\\\SERVER\\share\\dir', 'win32')).toBe(true)
    expect(isPathInside('/repo', '/repo/src', 'linux')).toBe(true)
  })

  it('Windows 风格路径在任何主机都选 win32 实现', () => {
    expect(pickPathImpl('C:\\Repo', 'a.ts', 'linux').sep).toBe('\\')
    expect(pickPathImpl('/repo', '/repo/a.ts', 'linux').sep).toBe('/')
    expect(pickPathImpl('/repo', '/repo/a.ts', 'win32').sep).toBe('\\')
  })
})
