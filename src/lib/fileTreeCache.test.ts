import { describe, expect, it } from 'vitest'
import { preserveLoadedChildren, revealNeedsTreeLoad } from './fileTreeCache'
import type { FileNode } from '../utils/fileTreeHelpers'
import type { Project } from '../types'

describe('preserveLoadedChildren', () => {
  it('keeps an expanded directory when a root refresh finishes afterwards', () => {
    const existing: FileNode[] = [
      {
        name: '.qingcode',
        path: 'D:\\project\\.qingcode',
        is_dir: true,
        loaded: true,
        children: [{ name: 'run.json', path: 'D:\\project\\.qingcode\\run.json', is_dir: false }],
      },
    ]
    const refreshed: FileNode[] = [
      { name: '.qingcode', path: 'D:/project/.qingcode', is_dir: true, loaded: false },
      { name: 'src', path: 'D:/project/src', is_dir: true, loaded: false },
    ]

    expect(preserveLoadedChildren(refreshed, existing)).toEqual([
      {
        name: '.qingcode',
        path: 'D:/project/.qingcode',
        is_dir: true,
        loaded: true,
        children: [{ name: 'run.json', path: 'D:\\project\\.qingcode\\run.json', is_dir: false }],
      },
      { name: 'src', path: 'D:/project/src', is_dir: true, loaded: false },
    ])
  })

  it('drops deleted children when merging a forced directory reload', () => {
    const existing: FileNode[] = [
      {
        name: 'test',
        path: 'D:/proj/test',
        is_dir: true,
        loaded: true,
        children: [
          { name: 'keep', path: 'D:/proj/test/keep', is_dir: true, loaded: true, children: [] },
          { name: 'gone', path: 'D:/proj/test/gone', is_dir: true, loaded: true, children: [] },
        ],
      },
    ]
    const refreshed: FileNode[] = [
      { name: 'keep', path: 'D:/proj/test/keep', is_dir: true, loaded: false },
    ]

    expect(preserveLoadedChildren(refreshed, existing[0].children ?? [])).toEqual([
      {
        name: 'keep',
        path: 'D:/proj/test/keep',
        is_dir: true,
        loaded: true,
        children: [],
      },
    ])
  })
})

describe('revealNeedsTreeLoad', () => {
  const project: Project = {
    id: 'p1',
    name: 'repo',
    path: 'D:/repo/eman-nem',
    created_at: 0,
    last_opened_at: 0,
    hidden: 0,
    sort_order: 0,
  }

  it('returns false when ancestor folders are already loaded', () => {
    const tree: FileNode[] = [
      {
        name: 'src',
        path: 'D:/repo/eman-nem/src',
        is_dir: true,
        loaded: true,
        children: [
          {
            name: 'Foo.java',
            path: 'D:/repo/eman-nem/src/Foo.java',
            is_dir: false,
            loaded: true,
          },
        ],
      },
    ]

    expect(
      revealNeedsTreeLoad(tree, 'D:/repo/eman-nem/src/Foo.java', project),
    ).toBe(false)
  })

  it('returns true when a parent directory is not loaded yet', () => {
    const tree: FileNode[] = [
      { name: 'src', path: 'D:/repo/eman-nem/src', is_dir: true, loaded: false },
    ]

    expect(
      revealNeedsTreeLoad(tree, 'D:/repo/eman-nem/src/Foo.java', project),
    ).toBe(true)
  })
})
