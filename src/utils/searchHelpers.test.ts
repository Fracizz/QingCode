import { describe, expect, it } from 'vitest'
import {
  buildContentResultRows,
  buildFilenameResultRows,
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

describe('buildFilenameResultRows', () => {
  it('groups hits by directory and prefixes multi-project names', () => {
    const rows = buildFilenameResultRows(
      [
        { name: 'a.ts', path: '/p1/src/a.ts', relative: 'src/a.ts', is_dir: false },
        { name: 'b.ts', path: '/p1/src/b.ts', relative: 'src/b.ts', is_dir: false },
        { name: 'c.ts', path: '/p2/c.ts', relative: 'c.ts', is_dir: false },
      ],
      path => (path.startsWith('/p1') ? 'one' : path.startsWith('/p2') ? 'two' : null),
    )
    expect(rows.filter(r => r.kind === 'dir').map(r => (r.kind === 'dir' ? r.dir : ''))).toEqual([
      'one / src',
      'two / (root)',
    ])
    expect(rows.filter(r => r.kind === 'fn')).toHaveLength(3)
  })
})

describe('buildContentResultRows', () => {
  it('emits file headers and collapses matches', () => {
    const files = [
      {
        name: 'a.ts',
        path: '/a.ts',
        relative: 'a.ts',
        matches: [
          { line: 1, text: 'foo', match_start: 0, match_end: 3 },
          { line: 2, text: 'bar', match_start: 0, match_end: 3 },
        ],
      },
    ]
    const open = buildContentResultRows(files, new Set(), () => null, 20)
    expect(open.map(r => r.kind)).toEqual(['file', 'match', 'match'])
    const collapsed = buildContentResultRows(files, new Set(['/a.ts']), () => null, 20)
    expect(collapsed.map(r => r.kind)).toEqual(['file'])
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
