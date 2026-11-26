import { describe, expect, it, vi } from 'vitest'
import type { LanguageDescription } from '@codemirror/language'
import { loadLanguageForPath, matchFileName, matchLanguageDescription } from './languages'

// 单测不触碰真实 language-data（它内部动态 import 全部语言包）；用假的 descriptions 代替。
const mocks = vi.hoisted(() => ({
  ts: { name: 'TypeScript', alias: ['ts'], extensions: ['ts', 'tsx'], filename: undefined, load: vi.fn(async () => []) },
  docker: { name: 'Dockerfile', alias: [], extensions: [], filename: /^Dockerfile$/, load: vi.fn(async () => ['docker']) },
}))

vi.mock('@codemirror/language-data', () => ({ languages: [mocks.ts, mocks.docker] }))

const descs = [mocks.ts, mocks.docker] as unknown as readonly LanguageDescription[]

describe('语言匹配（mock language-data）', () => {
  it('Windows / POSIX 路径都只取文件名匹配', () => {
    expect(matchFileName('/repo/src/a.ts')).toBe('a.ts')
    expect(matchFileName('C:\\work\\repo\\a.ts')).toBe('a.ts')
    expect(matchLanguageDescription(descs, '/repo/src/a.ts')).toBe(mocks.ts)
    expect(matchLanguageDescription(descs, 'C:\\work\\repo\\a.TS')).toBe(mocks.ts)
  })

  it('filename 正则优先于扩展名', () => {
    expect(matchLanguageDescription(descs, '/repo/Dockerfile')).toBe(mocks.docker)
    expect(matchLanguageDescription(descs, 'Dockerfile')).toBe(mocks.docker)
  })

  it('找不到时纯文本；空路径返回 null', () => {
    expect(matchLanguageDescription(descs, '/repo/a.log')).toBe(null)
    expect(matchLanguageDescription(descs, '/repo/Makefile')).toBe(null)
    expect(matchLanguageDescription(descs, '')).toBe(null)
    expect(matchFileName('')).toBe('')
  })
})

describe('语言懒加载', () => {
  it('命中描述才调用 load，未知扩展直接返回空扩展', async () => {
    mocks.ts.load.mockClear()
    mocks.docker.load.mockClear()
    expect(await loadLanguageForPath('/repo/src/a.ts')).toEqual([])
    expect(mocks.ts.load).toHaveBeenCalledTimes(1)
    expect(await loadLanguageForPath('/repo/a.log')).toEqual([])
    expect(mocks.ts.load).toHaveBeenCalledTimes(1)
    expect(await loadLanguageForPath('/repo/Dockerfile')).toEqual(['docker'])
    expect(mocks.docker.load).toHaveBeenCalledTimes(1)
  })

  it('描述表或语言包加载失败时退化为纯文本', async () => {
    const broken = async () => {
      throw new Error('offline')
    }
    expect(await loadLanguageForPath('/repo/a.ts', broken)).toEqual([])
    const failing = [
      {
        name: 'TypeScript',
        alias: [],
        extensions: ['ts'],
        filename: undefined,
        load: async () => { throw new Error('missing chunk') },
      },
    ] as unknown as LanguageDescription[]
    expect(await loadLanguageForPath('/repo/a.ts', async () => failing)).toEqual([])
  })
})
