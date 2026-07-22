import { describe, expect, it, vi, beforeEach } from 'vitest'
import { preserveLoadedChildren, reloadLoadedChildren, revealNeedsTreeLoad } from './fileTreeCache'
import type { FileNode } from '../utils/fileTreeHelpers'
import type { Project } from '../types'

vi.mock('./tauri', () => ({
  safeInvoke: vi.fn(),
}))

vi.mock('./excludeSettings', () => ({
  loadExcludeSettingsForProject: vi.fn(async () => ({
    filesExclude: [],
    excludeGitIgnore: true,
  })),
}))

import { safeInvoke } from './tauri'

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

describe('reloadLoadedChildren', () => {
  beforeEach(() => {
    vi.mocked(safeInvoke).mockReset()
  })

  it('re-scans previously loaded folders instead of keeping stale children', async () => {
    const existing: FileNode[] = [
      {
        name: 'sshctl',
        path: 'D:/proj/skills/sshctl',
        is_dir: true,
        loaded: true,
        children: [
          { name: 'go.mod', path: 'D:/proj/skills/sshctl/go.mod', is_dir: false, loaded: true },
          { name: 'LICENSE', path: 'D:/proj/skills/sshctl/LICENSE', is_dir: false, loaded: true },
        ],
      },
    ]
    const fresh: FileNode[] = [
      { name: 'sshctl', path: 'D:/proj/skills/sshctl', is_dir: true, loaded: false },
    ]

    vi.mocked(safeInvoke).mockResolvedValueOnce([
      { name: 'bin', path: 'D:/proj/skills/sshctl/bin', is_dir: true },
      { name: 'SKILL.md', path: 'D:/proj/skills/sshctl/SKILL.md', is_dir: false },
    ])

    const next = await reloadLoadedChildren(fresh, existing, 'D:/proj', null)
    expect(next).toEqual([
      {
        name: 'sshctl',
        path: 'D:/proj/skills/sshctl',
        is_dir: true,
        loaded: true,
        children: [
          { name: 'bin', path: 'D:/proj/skills/sshctl/bin', is_dir: true, loaded: false },
          { name: 'SKILL.md', path: 'D:/proj/skills/sshctl/SKILL.md', is_dir: false, loaded: true },
        ],
      },
    ])
    expect(safeInvoke).toHaveBeenCalledWith(
      '展开目录',
      'scan_directory',
      expect.objectContaining({ path: 'D:/proj/skills/sshctl' })
    )
  })

  it('re-scans nested loaded directories', async () => {
    const existing: FileNode[] = [
      {
        name: 'src',
        path: 'D:/proj/src',
        is_dir: true,
        loaded: true,
        children: [
          {
            name: 'nested',
            path: 'D:/proj/src/nested',
            is_dir: true,
            loaded: true,
            children: [{ name: 'old.ts', path: 'D:/proj/src/nested/old.ts', is_dir: false }],
          },
        ],
      },
    ]
    const fresh: FileNode[] = [{ name: 'src', path: 'D:/proj/src', is_dir: true, loaded: false }]
    vi.mocked(safeInvoke)
      .mockResolvedValueOnce([{ name: 'nested', path: 'D:/proj/src/nested', is_dir: true }])
      .mockResolvedValueOnce([{ name: 'new.ts', path: 'D:/proj/src/nested/new.ts', is_dir: false }])

    await expect(reloadLoadedChildren(fresh, existing, 'D:/proj', null)).resolves.toEqual([
      {
        name: 'src',
        path: 'D:/proj/src',
        is_dir: true,
        loaded: true,
        children: [
          {
            name: 'nested',
            path: 'D:/proj/src/nested',
            is_dir: true,
            loaded: true,
            children: [
              { name: 'new.ts', path: 'D:/proj/src/nested/new.ts', is_dir: false, loaded: true },
            ],
          },
        ],
      },
    ])
  })

  it('keeps an unloaded placeholder when a nested rescan fails', async () => {
    const existing: FileNode[] = [
      {
        name: 'src',
        path: 'D:/proj/src',
        is_dir: true,
        loaded: true,
        children: [],
      },
    ]
    const fresh: FileNode[] = [{ name: 'src', path: 'D:/proj/src', is_dir: true, loaded: false }]
    vi.mocked(safeInvoke).mockRejectedValueOnce(new Error('directory disappeared'))

    await expect(reloadLoadedChildren(fresh, existing, 'D:/proj', null)).resolves.toEqual(fresh)
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

    expect(revealNeedsTreeLoad(tree, 'D:/repo/eman-nem/src/Foo.java', project)).toBe(false)
  })

  it('returns true when a parent directory is not loaded yet', () => {
    const tree: FileNode[] = [
      { name: 'src', path: 'D:/repo/eman-nem/src', is_dir: true, loaded: false },
    ]

    expect(revealNeedsTreeLoad(tree, 'D:/repo/eman-nem/src/Foo.java', project)).toBe(true)
  })
})
