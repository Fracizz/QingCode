import { describe, expect, it } from 'vitest'
import {
  collectQuickOpenFiles,
  filterQuickOpenFiles,
  mergeQuickOpenEntries,
  parseQuickOpenLocation,
  quickOpenEntriesFromSearchHits,
} from './quickOpen'

const project = { id: 'project-1', name: '示例项目', path: 'D:/example' }

describe('quick open entries', () => {
  it('adds deep native search hits that the collapsed explorer tree does not contain', () => {
    const loaded = collectQuickOpenFiles([project], {
      'project-1': [
        { name: 'src', path: 'D:/example/src', is_dir: true },
        { name: 'README.md', path: 'D:/example/README.md', is_dir: false },
      ],
    })
    const native = quickOpenEntriesFromSearchHits(project, [
      {
        name: 'CommandPalette.tsx',
        path: 'D:/example/src/components/CommandPalette.tsx',
        relative: 'src\\components\\CommandPalette.tsx',
        is_dir: false,
      },
    ])

    const matches = filterQuickOpenFiles(mergeQuickOpenEntries(loaded, native), 'palette')

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      path: 'D:/example/src/components/CommandPalette.tsx',
      relativePath: 'src/components/CommandPalette.tsx',
    })
  })

  it('keeps the immediate tree entry when native search returns the same file', () => {
    const entries = mergeQuickOpenEntries(
      [{ id: 'D:/example/README.md', path: 'D:/example/README.md', label: 'README.md', relativePath: 'README.md', projectName: '示例项目' }],
      quickOpenEntriesFromSearchHits(project, [
        { name: 'README.md', path: 'd:/EXAMPLE/readme.md', relative: 'README.md', is_dir: false },
      ]),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe('D:/example/README.md')
  })
})

describe('parseQuickOpenLocation', () => {
  it('parses line and column suffixes', () => {
    expect(parseQuickOpenLocation('foo.ts:42')).toEqual({
      fileQuery: 'foo.ts',
      line: 42,
    })
    expect(parseQuickOpenLocation('path/to/bar.tsx:10:5')).toEqual({
      fileQuery: 'path/to/bar.tsx',
      line: 10,
      column: 5,
    })
  })

  it('keeps Windows paths intact', () => {
    expect(parseQuickOpenLocation(String.raw`C:\src\app.ts:99`)).toEqual({
      fileQuery: 'C:/src/app.ts',
      line: 99,
    })
    expect(parseQuickOpenLocation('C:/src/app.ts:12:3')).toEqual({
      fileQuery: 'C:/src/app.ts',
      line: 12,
      column: 3,
    })
  })

  it('does not treat a drive letter as a line suffix', () => {
    expect(parseQuickOpenLocation('C:42')).toEqual({ fileQuery: 'C:42' })
  })

  it('parses Alt+C @project/path#L references', () => {
    expect(parseQuickOpenLocation('@qingcode/.qingcode/run.json#L17')).toEqual({
      fileQuery: '.qingcode/run.json',
      line: 17,
      projectName: 'qingcode',
    })
    expect(parseQuickOpenLocation('@App/src/a.ts#L10-L12')).toEqual({
      fileQuery: 'src/a.ts',
      line: 10,
      projectName: 'App',
    })
  })
})

describe('filterQuickOpenFiles with location suffix', () => {
  const entries = [
    {
      id: 'D:/example/foo.ts',
      path: 'D:/example/foo.ts',
      label: 'foo.ts',
      relativePath: 'src/foo.ts',
      projectName: '示例项目',
    },
    {
      id: 'D:/qingcode/.qingcode/run.json',
      path: 'D:/qingcode/.qingcode/run.json',
      label: 'run.json',
      relativePath: '.qingcode/run.json',
      projectName: 'qingcode',
    },
    {
      id: 'D:/other/.qingcode/run.json',
      path: 'D:/other/.qingcode/run.json',
      label: 'run.json',
      relativePath: '.qingcode/run.json',
      projectName: 'other',
    },
  ]

  it('matches using the path portion only', () => {
    const matches = filterQuickOpenFiles(entries, 'foo.ts:42')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.label).toBe('foo.ts')
  })

  it('matches relative and absolute path fragments', () => {
    expect(filterQuickOpenFiles(entries, 'src/foo')).toHaveLength(1)
    expect(filterQuickOpenFiles(entries, 'd:/example/foo.ts')).toHaveLength(1)
  })

  it('scopes @project/#L refs and prefers exact relative paths', () => {
    const matches = filterQuickOpenFiles(entries, '@qingcode/.qingcode/run.json#L17')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.path).toBe('D:/qingcode/.qingcode/run.json')
    expect(parseQuickOpenLocation('@qingcode/.qingcode/run.json#L17').line).toBe(17)
  })
})
