import { describe, expect, it } from 'vitest'
import {
  createTreeDepth,
  dirsToReveal,
  findVisibleNodeRowIndex,
  flattenVisibleNodes,
  moveVisibleNodeSelection,
  resolveTreeRevealScrollIndex,
} from './fileTreeView'
import type { FileNode } from './fileTreeHelpers'

describe('createTreeDepth / dirsToReveal', () => {
  it('computes depth from project root', () => {
    expect(createTreeDepth('D:/proj', 'D:/proj')).toBe(1)
    expect(createTreeDepth('D:/proj/src/util', 'D:/proj')).toBe(3)
  })

  it('lists dirs that must be expanded to reveal a parent', () => {
    expect(dirsToReveal('D:/proj/src/util', 'D:/proj')).toEqual(['D:/proj/src', 'D:/proj/src/util'])
    expect(dirsToReveal('D:/proj', 'D:/proj')).toEqual([])
  })
})

describe('flattenVisibleNodes', () => {
  const tree: FileNode[] = [
    {
      name: 'src',
      path: '/src',
      is_dir: true,
      loaded: true,
      children: [
        { name: 'a.ts', path: '/src/a.ts', is_dir: false },
        {
          name: 'util',
          path: '/src/util',
          is_dir: true,
          loaded: true,
          children: [{ name: 'b.ts', path: '/src/util/b.ts', is_dir: false }],
        },
      ],
    },
  ]

  it('includes children only when expanded', () => {
    const collapsed = flattenVisibleNodes(tree, new Set(), null)
    expect(collapsed.map(r => (r.kind === 'node' ? r.node.path : r.kind))).toEqual(['/src'])

    const expanded = flattenVisibleNodes(tree, new Set(['/src', '/src/util']), null)
    expect(expanded.filter(r => r.kind === 'node').map(r => r.node.path)).toEqual([
      '/src',
      '/src/a.ts',
      '/src/util',
      '/src/util/b.ts',
    ])
  })

  it('treats expanded paths as equal across separators', () => {
    const winTree: FileNode[] = [
      {
        name: 'test',
        path: 'D:\\proj\\test',
        is_dir: true,
        loaded: true,
        children: [{ name: 'a.log', path: 'D:\\proj\\test\\a.log', is_dir: false }],
      },
    ]
    const rows = flattenVisibleNodes(winTree, new Set(['D:/proj/test']), null)
    expect(rows.filter(r => r.kind === 'node').map(r => r.node.name)).toEqual(['test', 'a.log'])
  })

  it('inserts pending create row under parent', () => {
    const rows = flattenVisibleNodes(tree, new Set(['/src']), {
      projectId: 'p',
      parentPath: '/src',
      directory: false,
      depth: 2,
    })
    expect(rows.some(r => r.kind === 'create' && r.directory === false)).toBe(true)
  })

  it('replaces node with rename row while renaming', () => {
    const rows = flattenVisibleNodes(
      tree,
      new Set(['/src']),
      null,
      { path: '/src/a.ts', name: 'a.ts', isDir: false, depth: 2 },
    )
    const rename = rows.find(r => r.kind === 'rename')
    expect(rename?.kind === 'rename' && rename.node.path).toBe('/src/a.ts')
    expect(rows.some(r => r.kind === 'node' && r.node.path === '/src/a.ts')).toBe(false)
  })
})

describe('findVisibleNodeRowIndex / resolveTreeRevealScrollIndex', () => {
  const rows = flattenVisibleNodes(
    [
      {
        name: 'src',
        path: '/proj/src',
        is_dir: true,
        loaded: true,
        children: [{ name: 'a.ts', path: '/proj/src/a.ts', is_dir: false }],
      },
    ],
    new Set(['/proj/src']),
    null,
  )

  it('finds a visible node row', () => {
    expect(findVisibleNodeRowIndex(rows, '/proj/src/a.ts')).toBe(1)
    expect(findVisibleNodeRowIndex(rows, '/missing')).toBe(-1)
  })

  it('resolves reveal scroll targets', () => {
    expect(resolveTreeRevealScrollIndex(rows, '/proj', '/proj', null)).toBe(0)
    expect(resolveTreeRevealScrollIndex(rows, '/proj/src/a.ts', '/proj', null)).toBe(1)
    expect(resolveTreeRevealScrollIndex(rows, '/proj/src/hidden.ts', '/proj', null)).toBeNull()
  })

  it('prefers pending create row when present', () => {
    const withCreate = flattenVisibleNodes(
      [
        {
          name: 'src',
          path: '/proj/src',
          is_dir: true,
          loaded: true,
          children: [],
        },
      ],
      new Set(['/proj/src']),
      {
        projectId: 'p',
        parentPath: '/proj/src',
        directory: true,
        depth: 2,
      },
    )
    expect(resolveTreeRevealScrollIndex(withCreate, '/proj/src/a.ts', '/proj', {
      projectId: 'p',
      parentPath: '/proj/src',
      directory: true,
      depth: 2,
    })).toBe(1)
  })
})

describe('moveVisibleNodeSelection', () => {
  const rows = flattenVisibleNodes(
    [
      {
        name: 'a',
        path: '/a',
        is_dir: false,
      },
      {
        name: 'b',
        path: '/b',
        is_dir: false,
      },
    ],
    new Set(),
    null,
  )

  it('moves up and down among node rows', () => {
    expect(moveVisibleNodeSelection(rows, '/a', 'down')?.path).toBe('/b')
    expect(moveVisibleNodeSelection(rows, '/b', 'up')?.path).toBe('/a')
    expect(moveVisibleNodeSelection(rows, null, 'down')?.path).toBe('/a')
  })

  it('jumps to home and end', () => {
    expect(moveVisibleNodeSelection(rows, '/b', 'home')?.path).toBe('/a')
    expect(moveVisibleNodeSelection(rows, '/a', 'end')?.path).toBe('/b')
  })
})

