import { describe, expect, it } from 'vitest'
import { removeNodeFromTree, type FileNode } from './fileTreeHelpers'

describe('removeNodeFromTree', () => {
  it('removes a nested unavailable directory', () => {
    const tree: FileNode[] = [
      {
        name: 'deps',
        path: 'D:/proj/target/debug/deps',
        is_dir: true,
        loaded: true,
        children: [
          { name: 'keep', path: 'D:/proj/target/debug/deps/keep', is_dir: false },
          {
            name: 'rmetawvl1Na',
            path: 'D:/proj/target/debug/deps/rmetawvl1Na',
            is_dir: true,
            loaded: false,
          },
        ],
      },
    ]

    const next = removeNodeFromTree(tree, 'D:\\proj\\target\\debug\\deps\\rmetawvl1Na')
    expect(next[0]?.children?.map(c => c.name)).toEqual(['keep'])
  })
})
