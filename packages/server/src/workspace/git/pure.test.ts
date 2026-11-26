import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceError } from '../registry'
import { planSwitch, toRepoRelative } from './pure'

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
