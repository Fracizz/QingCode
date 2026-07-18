import { describe, expect, it } from 'vitest'
import { preserveLoadedChildren } from './fileTreeCache'
import type { FileNode } from '../utils/fileTreeHelpers'

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
})
