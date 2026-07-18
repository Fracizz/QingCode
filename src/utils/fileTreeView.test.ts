import { describe, expect, it } from 'vitest'
import { createTreeDepth, dirsToReveal, flattenVisibleNodes } from './fileTreeView'
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
})
