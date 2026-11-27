import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import {
  canonicalizeRepoRelative,
  needCaseCanonicalization,
  planSwitch,
  toRepoRelative,
} from './pure'

const root = path.resolve(path.parse(process.cwd()).root, 'repo')

describe('toRepoRelative', () => {
  it('绝对路径转成仓库根相对、/ 分隔', () => {
    expect(toRepoRelative(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(toRepoRelative(root, 'src\\a.ts')).toBe('src/a.ts')
    expect(toRepoRelative(root, './src/../src/a.ts')).toBe('src/a.ts')
  })

  it('根本身转成 "."', () => {
    expect(toRepoRelative(root, root)).toBe('.')
  })

  it('越界路径与 NUL 返回 params 错误', () => {
    const outside = path.resolve(path.dirname(root), 'other', 'x')
    for (const value of ['../x', outside, 'a/../../x', 'x\0y']) {
      try {
        toRepoRelative(root, value)
        throw new Error('应当抛出 WorkspaceError')
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceError)
        expect((err as WorkspaceError).code).toBe('params')
      }
    }
  })
})

describe('Windows 根相对路径', () => {
  const winRoot = 'C:\\Repo'

  it('盘符大小写、混用斜杠与长路径前缀都得到同一相对路径', () => {
    expect(toRepoRelative(winRoot, 'c:/repo/src/a.ts', 'win32')).toBe('src/a.ts')
    expect(toRepoRelative('C:/Repo', 'C:\\REPO\\src\\中文.ts', 'win32')).toBe('src/中文.ts')
    expect(toRepoRelative('\\\\?\\C:\\Repo', '\\\\?\\C:\\Repo\\src\\a.ts', 'win32')).toBe(
      'src/a.ts',
    )
    expect(toRepoRelative('\\\\?\\C:\\Repo', 'c:/repo/src/a.ts', 'win32')).toBe('src/a.ts')
  })

  it('UNC 根与从 POSIX 主机解析 Windows 路径', () => {
    expect(
      toRepoRelative('\\\\server\\share\\repo', '\\\\SERVER\\share\\repo\\src\\a.ts', 'win32'),
    ).toBe('src/a.ts')
    expect(toRepoRelative(winRoot, 'c:/repo/src/a.ts', 'linux')).toBe('src/a.ts')
  })

  it('识别 SFTP 盘符路径并继续验证仓库边界', () => {
    expect(toRepoRelative(winRoot, '/c:/repo/src/中文.ts', 'win32')).toBe('src/中文.ts')
    expect(toRepoRelative('/C:/Repo', 'C:\\Repo\\src\\a.ts', 'win32')).toBe('src/a.ts')
    expect(() => toRepoRelative(winRoot, '/D:/Other/a.ts', 'win32')).toThrow(/不在仓库内/)
    expect(toRepoRelative('/C:/repo', '/C:/repo/src/a.ts', 'linux')).toBe('src/a.ts')
  })

  it('越界路径仍报 params', () => {
    expect(() => toRepoRelative(winRoot, 'D:\\Other\\a.ts', 'win32')).toThrow(/不在仓库内/)
  })

  it('按磁盘真实大小写归一相对路径（git pathspec 区分大小写）', () => {
    const entries: Record<string, string[]> = {
      'C:\\Repo': ['Src', 'CaseFile.txt', '.git'],
      'C:\\Repo\\Src': ['Nested', 'A.ts'],
      'C:\\Repo\\Src\\Nested': ['B.ts'],
    }
    const readdir = (dir: string): string[] => entries[dir] ?? []
    expect(canonicalizeRepoRelative(winRoot, 'src/nested/b.ts', readdir)).toBe(
      'Src/Nested/B.ts',
    )
    expect(canonicalizeRepoRelative(winRoot, 'casefile.txt', readdir)).toBe('CaseFile.txt')
    // 找不到的段（新建/已删除）保留原写法。
    expect(canonicalizeRepoRelative(winRoot, 'src/new.txt', readdir)).toBe('Src/new.txt')
    expect(canonicalizeRepoRelative(winRoot, '.', readdir)).toBe('.')
    expect(canonicalizeRepoRelative(winRoot, 'Src/Nested/B.ts', readdir, true)).toBe(
      'Src/Nested/B.ts',
    )
    expect(needCaseCanonicalization(winRoot, 'win32')).toBe(true)
    expect(needCaseCanonicalization('/repo', 'linux')).toBe(false)
  })
})

describe('planSwitch', () => {
  const refs = {
    local: [
      { name: 'main', head: 'h1' },
      { name: 'feature/x', head: 'h2' },
    ],
    remote: [
      { name: 'origin/main', head: 'h1' },
      { name: 'origin/topic', head: 'h3' },
    ],
  }

  it('create 优先，普通分支直接 switch', () => {
    expect(planSwitch('new', true, refs).args).toEqual(['switch', '-c', 'new'])
    expect(planSwitch('feature/x', false, refs).args).toEqual(['switch', 'feature/x'])
  })

  it('远端分支：本地已存在切本地，否则 --track', () => {
    expect(planSwitch('origin/main', false, refs).args).toEqual(['switch', 'main'])
    expect(planSwitch('origin/topic', false, refs).args).toEqual([
      'switch',
      '--track',
      'origin/topic',
    ])
  })

  it('多层分支名去掉第一段作为本地名', () => {
    const nested = { local: [], remote: [{ name: 'origin/feature/deep', head: 'h' }] }
    expect(planSwitch('origin/feature/deep', false, nested).args).toEqual([
      'switch',
      '--track',
      'origin/feature/deep',
    ])
    expect(planSwitch('origin/feature/deep', false, { ...nested, local: [{ name: 'feature/deep', head: 'h' }] }).args).toEqual([
      'switch',
      'feature/deep',
    ])
  })
})
