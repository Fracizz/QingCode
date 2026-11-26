import { describe, expect, it } from 'vitest'
import {
  allowLocalUrl,
  basename,
  findPathsInText,
  imageDataUrl,
  isAbsolutePath,
  isImagePath,
  joinPath,
  normalizePath,
  parseFileHref,
  resolvePath,
  segmentPaths,
  splitLocation,
} from './fileLinks'

describe('路径运算', () => {
  it('规范化与拼接保留各种根', () => {
    expect(normalizePath('/home/user/.././repo//a.ts')).toBe('/home/repo/a.ts')
    expect(normalizePath('C:\\Users\\..\\repo\\')).toBe('C:\\repo')
    expect(normalizePath('/C:/a/../b.ts')).toBe('C:/b.ts')
    expect(joinPath('/home/user', 'src', '..', 'a.ts')).toBe('/home/user/a.ts')
    expect(joinPath('C:\\work\\repo', 'src/a.ts')).toBe('C:\\work\\repo\\src\\a.ts')
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('~/a.ts')).toBe(false)
    expect(basename('C:\\a\\b.png')).toBe('b.png')
    expect(isImagePath('a/b.PNG')).toBe(true)
    expect(isImagePath('a/b.ts')).toBe(false)
    expect(imageDataUrl('AAAA', 'x.png')).toBe('data:image/png;base64,AAAA')
    expect(imageDataUrl('data:image/gif;base64,R0', 'x.png')).toBe('data:image/gif;base64,R0')
  })

  it('相对路径按会话 cwd 解析', () => {
    expect(resolvePath('src/a.ts', '/srv/app')).toBe('/srv/app/src/a.ts')
    expect(resolvePath('src/a.ts', 'D:\\code\\repo')).toBe('D:\\code\\repo\\src\\a.ts')
    expect(resolvePath('/etc/hosts', 'D:\\code')).toBe('/etc/hosts')
    expect(resolvePath('a.ts', '')).toBe('a.ts')
    expect(resolvePath('  ', '/x')).toBe('')
  })
})

describe('行号后缀与链接', () => {
  it('拆出 :行[:列] 与 #L 片段，盘符相对写法不误判', () => {
    expect(splitLocation('src/a.ts:42')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(splitLocation('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42, column: 7 })
    expect(splitLocation('src/a.ts#L12C3')).toEqual({ path: 'src/a.ts', line: 12, column: 3 })
    expect(splitLocation('C:12')).toEqual({ path: 'C:12' })
  })

  it('Markdown href → 本地文件；外链与锚点返回 null', () => {
    expect(parseFileHref('src/a.ts:10', '/repo')).toEqual({ path: '/repo/src/a.ts', line: 10 })
    expect(parseFileHref('file:///C:/repo/a.ts#L5', '')).toEqual({ path: 'C:/repo/a.ts', line: 5 })
    expect(parseFileHref('C:\\repo\\a%20b.ts', '')).toEqual({ path: 'C:\\repo\\a b.ts' })
    expect(parseFileHref('https://example.com/a.ts', '/repo')).toBeNull()
    expect(parseFileHref('mailto:a@b.c', '/repo')).toBeNull()
    expect(parseFileHref('#section', '/repo')).toBeNull()
    expect(parseFileHref('README.md', '')).toBeNull()
    expect(parseFileHref('~/notes.md', '')).toEqual({ path: '~/notes.md' })
  })

  it('放行 file: 与盘符链接，其他不安全协议仍被清空', () => {
    expect(allowLocalUrl('https://a', 'https://a')).toBe('https://a')
    expect(allowLocalUrl('file:///a.ts', '')).toBe('file:///a.ts')
    expect(allowLocalUrl('C:\\a.ts', '')).toBe('C:\\a.ts')
    expect(allowLocalUrl('javascript:alert(1)', '')).toBe('')
  })
})

describe('文本中的路径识别', () => {
  it('识别行内代码里的路径并排除 URL、版本号、域名', () => {
    const matches = findPathsInText('改了 src/store.ts:42 和 ./README.md，见 https://a.com/x.ts 与 1.2/3.4 以及 example.com/a')
    expect(matches.map((item) => item.path)).toEqual(['src/store.ts', './README.md'])
    expect(matches[0]?.line).toBe(42)
    expect(findPathsInText('C:\\code\\a.ts:3')[0]).toMatchObject({ path: 'C:\\code\\a.ts', line: 3 })
    expect(findPathsInText('plain text without paths')).toEqual([])
  })

  it('切成普通片段与路径片段', () => {
    const segments = segmentPaths('见 src/a.ts:3 处')
    expect(segments.map((item) => item.text)).toEqual(['见 ', 'src/a.ts:3', ' 处'])
    expect(segments[1]?.match?.line).toBe(3)
    expect(segmentPaths('')).toEqual([])
  })
})
