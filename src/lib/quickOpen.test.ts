import { describe, expect, it } from 'vitest'
import {
  collectQuickOpenFiles,
  filterQuickOpenFiles,
  mergeQuickOpenEntries,
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
