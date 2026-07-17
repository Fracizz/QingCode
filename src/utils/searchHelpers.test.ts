import { describe, expect, it } from 'vitest'
import {
  dirOf,
  isGlobPattern,
  isNavigable,
  rowHeightOf,
  trimContentFiles,
  typeFilterExtensions,
  typeFilterLabel,
} from './searchHelpers'

describe('type filters', () => {
  it('labels and expands filters', () => {
    expect(typeFilterLabel(null)).toBe('全部类型')
    expect(typeFilterLabel({ kind: 'ext', ext: 'ts' })).toBe('.ts')
    expect(typeFilterLabel({ kind: 'star', exts: ['md', 'txt'] })).toBe('*')
    expect(typeFilterExtensions({ kind: 'ext', ext: 'rs' })).toEqual(['rs'])
    expect(typeFilterExtensions({ kind: 'star', exts: ['a', 'b'] })).toEqual(['a', 'b'])
  })
})

describe('search row helpers', () => {
  it('detects globs and navigable rows', () => {
    expect(isGlobPattern('*.ts')).toBe(true)
    expect(isGlobPattern('foo')).toBe(false)
    expect(isNavigable({ kind: 'match', path: 'a', line: 1, text: 'x', matchStart: 0, matchEnd: 1 })).toBe(
      true,
    )
    expect(isNavigable({ kind: 'more', path: 'a' })).toBe(false)
  })

  it('computes row heights and parent dirs', () => {
    expect(rowHeightOf({ kind: 'file', path: 'a', name: 'a', dir: '', matchCount: 1, collapsed: false })).toBe(
      24,
    )
    expect(dirOf('src/utils/a.ts')).toBe('src/utils')
    expect(dirOf('a.ts')).toBe('')
  })
})

describe('trimContentFiles', () => {
  it('caps total matches across files', () => {
    const files = [
      {
        name: 'a.ts',
        path: '/a.ts',
        relative: 'a.ts',
        matches: [
          { line: 1, text: 'one', match_start: 0, match_end: 3 },
          { line: 2, text: 'two', match_start: 0, match_end: 3 },
        ],
      },
      {
        name: 'b.ts',
        path: '/b.ts',
        relative: 'b.ts',
        matches: [{ line: 1, text: 'three', match_start: 0, match_end: 5 }],
      },
    ]
    const trimmed = trimContentFiles(files, 2)
    expect(trimmed).toHaveLength(1)
    expect(trimmed[0].matches).toHaveLength(2)
    expect(trimContentFiles(files, 3)).toHaveLength(2)
  })
})
