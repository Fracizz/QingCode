import { describe, expect, it } from 'vitest'
import { baseName, normalizeProjectPath, patchTree, type FileNode } from './fileTreeHelpers'

describe('normalizeProjectPath / baseName', () => {
  it('normalizes for comparison', () => {
    expect(normalizeProjectPath('D:\\Work\\Demo\\')).toBe('d:/work/demo')
  })

  it('extracts basename', () => {
    expect(baseName('D:/Work/Demo')).toBe('Demo')
    expect(baseName('D:\\Work\\Demo\\')).toBe('Demo')
  })
})

describe('patchTree', () => {
  const tree: FileNode[] = [
    {
      name: 'src',
      path: '/proj/src',
      is_dir: true,
      loaded: true,
      children: [
        { name: 'a.ts', path: '/proj/src/a.ts', is_dir: false },
        {
          name: 'util',
          path: '/proj/src/util',
          is_dir: true,
          loaded: false,
        },
      ],
    },
  ]

  it('patches nested children immutably', () => {
    const next = patchTree(tree, '/proj/src/util', () => [
      { name: 'b.ts', path: '/proj/src/util/b.ts', is_dir: false },
    ])
    expect(tree[0].children?.[1].children).toBeUndefined()
    expect(next[0].children?.[1].loaded).toBe(true)
    expect(next[0].children?.[1].children).toEqual([
      { name: 'b.ts', path: '/proj/src/util/b.ts', is_dir: false },
    ])
    expect(next[0].children?.[0].path).toBe('/proj/src/a.ts')
  })

  it('matches Windows path separators when patching', () => {
    const winTree: FileNode[] = [
      { name: 'test', path: 'D:\\proj\\test', is_dir: true, loaded: false },
    ]
    const next = patchTree(winTree, 'D:/proj/test', () => [
      { name: 'a.log', path: 'D:\\proj\\test\\a.log', is_dir: false },
    ])
    expect(next[0].loaded).toBe(true)
    expect(next[0].children?.[0].name).toBe('a.log')
  })
})
