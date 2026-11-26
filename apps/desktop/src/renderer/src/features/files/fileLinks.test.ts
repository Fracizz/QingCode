import { describe, expect, it } from 'vitest'
import {
  basename,
  dirname,
  extname,
  fileKind,
  findPathsInText,
  imageDataUrl,
  imageMime,
  isAbsolutePath,
  langForPath,
  joinPath,
  normalizePath,
  parseFileHref,
  pathStyle,
  splitLocation,
} from './fileLinks'

describe('路径运算（POSIX / Windows）', () => {
  it('按盘符、反斜杠、UNC 判断风格', () => {
    expect(pathStyle('/home/a')).toBe('posix')
    expect(pathStyle('C:/a')).toBe('windows')
    expect(pathStyle('C:\\a')).toBe('windows')
    expect(pathStyle('/C:/a')).toBe('windows')
    expect(pathStyle('src\\a.ts')).toBe('windows')
    expect(pathStyle('\\\\server\\share\\a')).toBe('windows')
  })

  it('规范化 . / .. 与重复分隔符，保留各种根', () => {
    expect(normalizePath('/home/user/.././repo//a.ts')).toBe('/home/repo/a.ts')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('C:\\Users\\..\\repo\\')).toBe('C:\\repo')
    expect(normalizePath('C:/')).toBe('C:/')
    expect(normalizePath('C:\\')).toBe('C:\\')
    expect(normalizePath('/../../a')).toBe('/a')
    expect(normalizePath('../a/../b.ts')).toBe('../b.ts')
    expect(normalizePath('/C:/a/../b.ts')).toBe('C:/b.ts')
    expect(normalizePath('  ')).toBe('')
  })

  it('判断是否绝对路径', () => {
    expect(isAbsolutePath('/home/a')).toBe(true)
    expect(isAbsolutePath('C:\\a')).toBe(true)
    expect(isAbsolutePath('C:/a')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('/C:/a')).toBe(true)
    expect(isAbsolutePath('src/a.ts')).toBe(false)
    expect(isAbsolutePath('./a.ts')).toBe(false)
    expect(isAbsolutePath('~/a.ts')).toBe(false)
  })

  it('按 cwd 风格拼接并规范化', () => {
    expect(joinPath('/home/user', 'src', '..', 'a.ts')).toBe('/home/user/a.ts')
    expect(joinPath('/home/user', '../other/a.ts')).toBe('/home/other/a.ts')
    expect(joinPath('C:\\work\\repo', 'src/a.ts')).toBe('C:\\work\\repo\\src\\a.ts')
    expect(joinPath('C:/work/repo', '../a.ts')).toBe('C:/work/a.ts')
    expect(joinPath('/', 'a.ts')).toBe('/a.ts')
    expect(joinPath('C:\\', 'a.ts')).toBe('C:\\a.ts')
    expect(joinPath('', 'a.ts')).toBe('a.ts')
  })

  it('取目录名、文件名、扩展名', () => {
    expect(dirname('/home/user/a.ts')).toBe('/home/user')
    expect(dirname('/a.ts')).toBe('/')
    expect(dirname('C:\\work\\repo\\src\\a.ts')).toBe('C:\\work\\repo\\src')
    expect(dirname('C:/a.ts')).toBe('C:/')
    expect(dirname('a.ts')).toBe('')
    expect(basename('/home/user/a.ts')).toBe('a.ts')
    expect(basename('C:\\work\\repo\\a.ts')).toBe('a.ts')
    expect(basename('/')).toBe('')
    expect(extname('/home/user/a.ts')).toBe('.ts')
    expect(extname('/home/user/a.d.ts')).toBe('.ts')
    expect(extname('/home/user/.gitignore')).toBe('')
    expect(extname('/home/user/a.ts.')).toBe('')
    expect(extname('/home/user/README')).toBe('')
  })

  it('按扩展名分类并给出图片 MIME', () => {
    expect(fileKind('/a/logo.PNG')).toBe('image')
    expect(fileKind('C:\\a\\x.svg')).toBe('image')
    expect(fileKind('/a/readme.md')).toBe('markdown')
    expect(fileKind('/a/readme.mdx')).toBe('markdown')
    expect(fileKind('/a/main.ts')).toBe('text')
    expect(fileKind('/a/Makefile')).toBe('text')
    expect(imageMime('/a/logo.svg')).toBe('image/svg+xml')
    expect(imageMime('/a/logo.jpg')).toBe('image/jpeg')
    expect(imageMime('/a/main.ts')).toBe('application/octet-stream')
    expect(imageDataUrl('AAAA', '/a/logo.png')).toBe('data:image/png;base64,AAAA')
    expect(imageDataUrl('data:image/png;base64,AAAA', '/a/logo.png')).toBe('data:image/png;base64,AAAA')
    expect(imageDataUrl('  ', '/a/logo.png')).toBe('')
  })

  it('路径映射到 shiki 语言 id', () => {
    expect(langForPath('/a/main.ts')).toBe('typescript')
    expect(langForPath('/a/main.mjs')).toBe('javascript')
    expect(langForPath('C:\\a\\README.md')).toBe('markdown')
    expect(langForPath('/a/Dockerfile')).toBe('docker')
    expect(langForPath('/a/app.log')).toBe(null)
    expect(langForPath('/a/Makefile')).toBe('makefile')
  })
})

describe('位置后缀', () => {
  it('识别 #L12、#L12C3、#L12-L20', () => {
    expect(splitLocation('/a.ts#L12')).toEqual({ path: '/a.ts', line: 12 })
    expect(splitLocation('/a.ts#L12C3')).toEqual({ path: '/a.ts', line: 12, column: 3 })
    expect(splitLocation('/a.ts#L12-L20')).toEqual({ path: '/a.ts', line: 12 })
    expect(splitLocation('/a.ts#L12C3-L20C5')).toEqual({ path: '/a.ts', line: 12, column: 3 })
    expect(splitLocation('/a.ts#section')).toEqual({ path: '/a.ts' })
  })

  it('识别 :12、:12:3，不误伤盘符', () => {
    expect(splitLocation('/a/b.ts:12')).toEqual({ path: '/a/b.ts', line: 12 })
    expect(splitLocation('C:\\a\\b.ts:12:3')).toEqual({ path: 'C:\\a\\b.ts', line: 12, column: 3 })
    expect(splitLocation('C:12')).toEqual({ path: 'C:12' })
    expect(splitLocation('/a/b.ts:0')).toEqual({ path: '/a/b.ts' })
  })
})

describe('parseFileHref', () => {
  const cwd = '/home/user/repo'

  it('POSIX 绝对路径与行号', () => {
    expect(parseFileHref('/abs/foo.ts:12', cwd)).toEqual({ path: '/abs/foo.ts', line: 12 })
    expect(parseFileHref('/abs/foo.ts:12:3#L20', cwd)).toEqual({ path: '/abs/foo.ts', line: 20, column: 3 })
    expect(parseFileHref('/abs/foo.ts#L12C3', cwd)).toEqual({ path: '/abs/foo.ts', line: 12, column: 3 })
  })

  it('Windows 盘符路径（反斜杠 / 正斜杠 / /C:/）', () => {
    expect(parseFileHref('C:\\a\\b.ts:42', cwd)).toEqual({ path: 'C:\\a\\b.ts', line: 42 })
    expect(parseFileHref('C:/a/b.ts:12:3', cwd)).toEqual({ path: 'C:/a/b.ts', line: 12, column: 3 })
    expect(parseFileHref('/C:/a/b.ts#L12', cwd)).toEqual({ path: 'C:/a/b.ts', line: 12 })
  })

  it('file:// 与 URL 编码', () => {
    expect(parseFileHref('file:///home/user/a%20b.ts:8', cwd)).toEqual({ path: '/home/user/a b.ts', line: 8 })
    expect(parseFileHref('file:///C:/a/b.ts#L12', cwd)).toEqual({ path: 'C:/a/b.ts', line: 12 })
    expect(parseFileHref('file://localhost/tmp/a.ts', cwd)).toEqual({ path: '/tmp/a.ts' })
    expect(parseFileHref('file://nas/share/a.ts', cwd)).toMatchObject({ path: '\\\\nas\\share\\a.ts' })
  })

  it('相对路径按 cwd 解析（含 Windows cwd）', () => {
    expect(parseFileHref('src/a.ts:12', cwd)).toEqual({ path: '/home/user/repo/src/a.ts', line: 12 })
    expect(parseFileHref('./a.ts', cwd)).toEqual({ path: '/home/user/repo/a.ts' })
    expect(parseFileHref('../other/a.ts#L5', cwd)).toEqual({ path: '/home/user/other/a.ts', line: 5 })
    expect(parseFileHref('src\\a.ts:7', 'C:\\work\\repo')).toEqual({ path: 'C:\\work\\repo\\src\\a.ts', line: 7 })
    expect(parseFileHref('src/a.ts', '')).toBe(null)
  })

  it('其他协议、空链接、锚点返回 null', () => {
    expect(parseFileHref('https://example.com/a.ts', cwd)).toBe(null)
    expect(parseFileHref('http://example.com', cwd)).toBe(null)
    expect(parseFileHref('mailto:a@example.com', cwd)).toBe(null)
    expect(parseFileHref('vscode://file/C:/a.ts', cwd)).toBe(null)
    expect(parseFileHref('data:text/plain,hi', cwd)).toBe(null)
    expect(parseFileHref('', cwd)).toBe(null)
    expect(parseFileHref('#L12', cwd)).toBe(null)
    expect(parseFileHref('   ', cwd)).toBe(null)
  })

  it('去掉 Markdown 尖括号、query，保留 ~ 前缀', () => {
    expect(parseFileHref('</abs/a.ts:3>', cwd)).toEqual({ path: '/abs/a.ts', line: 3 })
    expect(parseFileHref('/abs/a.ts?v=1', cwd)).toEqual({ path: '/abs/a.ts' })
    expect(parseFileHref('~/notes/a.md', cwd)).toEqual({ path: '~/notes/a.md' })
  })
})

describe('findPathsInText', () => {
  it('找出带行号的行内代码路径', () => {
    const text = '修改 src/a.ts:42 以及 ../lib/b.ts:7:3 就好了'
    const found = findPathsInText(text)
    expect(found.map((item) => [text.slice(item.start, item.end), item.path, item.line, item.column])).toEqual([
      ['src/a.ts:42', 'src/a.ts', 42, undefined],
      ['../lib/b.ts:7:3', '../lib/b.ts', 7, 3],
    ])
  })

  it('识别绝对路径、Windows 路径、./ ../ ~/ 前缀', () => {
    expect(findPathsInText('/abs/a.ts:12')[0]).toMatchObject({ path: '/abs/a.ts', line: 12 })
    expect(findPathsInText('C:\\work\\a.ts:9')[0]).toMatchObject({ path: 'C:\\work\\a.ts', line: 9 })
    expect(findPathsInText('./scripts/build')[0]).toMatchObject({ path: './scripts/build' })
    expect(findPathsInText('~/notes/todo.md')[0]).toMatchObject({ path: '~/notes/todo.md' })
  })

  it('不误判 URL、版本号、比例、邮箱', () => {
    expect(findPathsInText('见 https://example.com/src/a.ts 与 http://x.com/a.ts')).toEqual([])
    expect(findPathsInText('www.example.com/src/a.ts')).toEqual([])
    expect(findPathsInText('example.com/src/a.ts')).toEqual([])
    expect(findPathsInText('版本 1.2.3 和 3/4 以及 10.0.0/8')).toEqual([])
    expect(findPathsInText('联系 a@example.com 或 user@host:/src/a.ts')).toEqual([])
    expect(findPathsInText('时间 12:30:45')).toEqual([])
  })

  it('start/end 与 raw 对得上，标点不会吞进路径', () => {
    const text = '看 (src/a.ts:12), 然后 C:/work/b.ts#L3.'
    const found = findPathsInText(text)
    expect(found).toHaveLength(2)
    for (const item of found) expect(text.slice(item.start, item.end)).toBe(item.raw)
    expect(found[0]).toMatchObject({ raw: 'src/a.ts:12', path: 'src/a.ts', line: 12 })
    expect(found[1]).toMatchObject({ raw: 'C:/work/b.ts#L3', path: 'C:/work/b.ts', line: 3 })
  })

  it('空文本、多行文本', () => {
    expect(findPathsInText('')).toEqual([])
    expect(findPathsInText('第一行\n第二行 src/a.ts\n')).toHaveLength(1)
  })
})
