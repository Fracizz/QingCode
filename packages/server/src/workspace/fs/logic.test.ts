import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import {
  DEFAULT_MAX_RESULTS,
  MAX_BASE64_READ_BYTES,
  MAX_UTF8_READ_BYTES,
  indexOfText,
  isAbsolutePath,
  isProtectedPath,
  looksBinary,
  mapNodeError,
  matchGlob,
  mtimeConflicts,
  parseReadParams,
  parseSearchParams,
  parseWatchPaths,
  parseWriteParams,
  truncateText,
  utf8SafeLength,
  watchChangedPath,
} from './logic'

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (err) {
    return err instanceof WorkspaceError ? err.code : `unexpected:${String(err)}`
  }
  return undefined
}

describe('绝对路径与参数校验', () => {
  it('接受 POSIX、Windows 盘符与 UNC 绝对路径', () => {
    expect(isAbsolutePath('/home/user/a.txt')).toBe(true)
    expect(isAbsolutePath('C:\\Users\\a.txt')).toBe(true)
    expect(isAbsolutePath('D:/work/a.ts')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.ts')).toBe(true)
    expect(isAbsolutePath('relative/a.ts')).toBe(false)
    expect(isAbsolutePath('C:a.ts')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
    expect(isAbsolutePath('/a\0b')).toBe(false)
    expect(isAbsolutePath(42)).toBe(false)
  })

  it('fs.read 默认 2 MiB、base64 10 MiB，并拒绝非法参数', () => {
    expect(parseReadParams({ path: '/tmp/a' })).toEqual({
      path: '/tmp/a',
      offset: 0,
      length: MAX_UTF8_READ_BYTES,
    })
    expect(parseReadParams({ path: 'C:\\a', encoding: 'base64' }).length).toBe(MAX_BASE64_READ_BYTES)
    expect(parseReadParams({ path: '/a', length: 999999999, encoding: 'base64' }).length).toBe(
      MAX_BASE64_READ_BYTES,
    )
    expect(parseReadParams({ path: '/a', offset: 3, length: 7, encoding: 'utf8' })).toEqual({
      path: '/a',
      offset: 3,
      length: 7,
      encoding: 'utf8',
    })
    expect(codeOf(() => parseReadParams({ path: 'a/b' }))).toBe('params')
    expect(codeOf(() => parseReadParams({ path: '/a', offset: -1 }))).toBe('params')
    expect(codeOf(() => parseReadParams({ path: '/a', length: 1.5 }))).toBe('params')
    expect(codeOf(() => parseReadParams({ path: '/a', encoding: 'latin1' }))).toBe('params')
  })

  it('fs.write / fs.search / fs.watch 参数逐个校验', () => {
    expect(parseWriteParams({ path: '/a', content: 'x' })).toEqual({
      path: '/a',
      content: 'x',
      create: true,
    })
    expect(
      parseWriteParams({ path: '/a', content: 'eA==', encoding: 'base64', expectedMtimeMs: 12, create: false }),
    ).toMatchObject({ encoding: 'base64', expectedMtimeMs: 12, create: false })
    expect(codeOf(() => parseWriteParams({ path: '/a' }))).toBe('params')
    expect(codeOf(() => parseWriteParams({ path: '/a', content: 'x', expectedMtimeMs: '1' }))).toBe(
      'params',
    )

    expect(parseSearchParams({ root: '/a', query: 'x', mode: 'name' })).toEqual({
      root: '/a',
      query: 'x',
      mode: 'name',
      caseSensitive: false,
      maxResults: DEFAULT_MAX_RESULTS,
    })
    expect(parseSearchParams({ root: '/a', query: 'x', mode: 'content', maxResults: 99999 }).maxResults).toBe(
      5000,
    )
    expect(codeOf(() => parseSearchParams({ root: 'a', query: 'x', mode: 'name' }))).toBe('params')
    expect(codeOf(() => parseSearchParams({ root: '/a', query: '', mode: 'name' }))).toBe('params')
    expect(codeOf(() => parseSearchParams({ root: '/a', query: 'x', mode: 'regex' }))).toBe('params')
    expect(codeOf(() => parseSearchParams({ root: '/a', query: 'x', mode: 'name', maxResults: 0 }))).toBe(
      'params',
    )

    expect(parseWatchPaths({ paths: ['/a', 'C:\\b'] })).toEqual(['/a', 'C:\\b'])
    expect(codeOf(() => parseWatchPaths({ paths: '/a' }))).toBe('params')
    expect(codeOf(() => parseWatchPaths({ paths: ['/a', 'rel'] }))).toBe('params')
  })
})

describe('Node 错误映射', () => {
  it('按 errno 映射到协议错误码', () => {
    const cases: Array<[string, string]> = [
      ['ENOENT', 'not_found'],
      ['EEXIST', 'exists'],
      ['ENOTEMPTY', 'not_empty'],
      ['EACCES', 'permission'],
      ['EPERM', 'permission'],
      ['EISDIR', 'internal'],
    ]
    for (const [errno, expected] of cases) {
      const err = Object.assign(new Error('失败'), { code: errno })
      expect(mapNodeError(err).code).toBe(expected)
    }
    expect(mapNodeError(new WorkspaceError('conflict', '自己抛的')).code).toBe('conflict')
    expect(mapNodeError(new Error('普通错误')).code).toBe('internal')
  })

  it('拒绝删除根目录与用户主目录本身', () => {
    expect(isProtectedPath(path.parse(process.cwd()).root, os.homedir())).toBe(true)
    expect(isProtectedPath(os.homedir())).toBe(true)
    expect(isProtectedPath(`${os.homedir()}${path.sep}`)).toBe(true)
    expect(isProtectedPath(path.join(os.homedir(), 'child'))).toBe(false)
    expect(isProtectedPath(path.parse(process.cwd()).root, '/somewhere/else')).toBe(true)
    expect(isProtectedPath('/', '/somewhere/else')).toBe(true)
    expect(isProtectedPath('/tmp/work', '/somewhere/else')).toBe(false)
  })
})

describe('二进制判断与 UTF-8 边界', () => {
  it('含 NUL 或大量非法 UTF-8 视为二进制', () => {
    expect(looksBinary(Buffer.from('普通中文文本'))).toBe(false)
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
    expect(looksBinary(Buffer.alloc(200, 0xff))).toBe(true)
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
    // 只抽样前 8 KiB，后面的 NUL 不影响判断。
    const big = Buffer.alloc(9000, 0x61)
    big[8999] = 0
    expect(looksBinary(big)).toBe(false)
    expect(looksBinary(big, 9000)).toBe(true)
  })

  it('截断的多字节字符回退到完整边界', () => {
    expect(utf8SafeLength(Buffer.from('hello'))).toBe(5)
    expect(utf8SafeLength(Buffer.from('a你'))).toBe(4)
    expect(utf8SafeLength(Buffer.from([0x61, 0xe4, 0xbd]))).toBe(1)
    expect(utf8SafeLength(Buffer.from([0xe4, 0xbd]))).toBe(0)
    expect(utf8SafeLength(Buffer.from([0xf0, 0x9f, 0x98]))).toBe(0)
    expect(utf8SafeLength(Buffer.from([0x61, 0x80, 0x62]))).toBe(3)
    expect(utf8SafeLength(Buffer.from([0xc0, 0xaf, 0x61]))).toBe(3)
  })

  it('匹配文本截断到 300 字符并去掉行尾换行', () => {
    expect(truncateText('hello\n')).toBe('hello')
    expect(truncateText('a'.repeat(301))).toHaveLength(300)
    expect(indexOfText('Hello World', 'hello', false)).toBe(0)
    expect(indexOfText('Hello World', 'hello', true)).toBe(-1)
  })
})

describe('冲突阈值与 watch 路径计算', () => {
  it('expectedMtimeMs 只有差 >1ms 才算冲突', () => {
    expect(mtimeConflicts(1000, undefined)).toBe(false)
    expect(mtimeConflicts(1000, 1000)).toBe(false)
    expect(mtimeConflicts(1000, 1000.8)).toBe(false)
    expect(mtimeConflicts(1000, 1001)).toBe(false)
    expect(mtimeConflicts(1000, 1001.5)).toBe(true)
    expect(mtimeConflicts(1000, 900)).toBe(true)
  })

  it('watch 变化路径优先用文件名，拿不到时退回被监听路径', () => {
    const dir = path.join(path.parse(process.cwd()).root, 'work')
    expect(watchChangedPath(dir, 'a.ts', true)).toBe(path.join(dir, 'a.ts'))
    expect(watchChangedPath(dir, Buffer.from('b.ts'), true)).toBe(path.join(dir, 'b.ts'))
    expect(watchChangedPath(dir, null, true)).toBe(dir)
    expect(watchChangedPath(dir, undefined, true)).toBe(dir)
    expect(watchChangedPath(dir, '', true)).toBe(dir)
    const file = path.join(dir, 'a.ts')
    expect(watchChangedPath(file, 'a.ts', false)).toBe(file)
    expect(watchChangedPath(file, null, false)).toBe(file)
  })
})

describe('glob 匹配', () => {
  it('支持 *、?、**、字符类与大小写', () => {
    expect(matchGlob('a.ts', '*.ts')).toBe(true)
    expect(matchGlob('src/deep/a.ts', '*.ts')).toBe(true)
    expect(matchGlob('src/deep/a.ts', 'src/**')).toBe(true)
    expect(matchGlob('a.ts', '**/*.ts')).toBe(true)
    expect(matchGlob('src/a.ts', 'src/*.ts')).toBe(true)
    expect(matchGlob('src/deep/a.ts', 'src/*.ts')).toBe(false)
    expect(matchGlob('ab.ts', 'a?.ts')).toBe(true)
    expect(matchGlob('a.ts', 'a?.ts')).toBe(false)
    expect(matchGlob('a.ts', '[ab].ts')).toBe(true)
    expect(matchGlob('c.ts', '[ab].ts')).toBe(false)
    expect(matchGlob('A.TS', '*.ts')).toBe(true)
    expect(matchGlob('A.TS', '*.ts', true)).toBe(false)
    expect(matchGlob('src\\a.ts', 'src/*.ts')).toBe(true)
  })
})
