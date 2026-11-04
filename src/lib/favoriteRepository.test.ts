import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavoriteItem } from '../types'

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}))

vi.mock('./projectRepository', () => ({
  withDb: async (_action: string, run: (db: typeof mockDb) => Promise<unknown>) => run(mockDb),
}))

import { loadFavoriteItems, replaceFavoriteItems } from './favoriteRepository'

describe('favoriteRepository', () => {
  beforeEach(() => {
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 })
  })

  it('maps persisted rows to available favorite items', async () => {
    mockDb.select.mockResolvedValue([
      {
        project_id: 'p1',
        relative_path: 'src/main.ts',
        item_type: 'file',
        sort_order: 2,
        created_at: 10,
      },
    ])

    await expect(loadFavoriteItems('p1')).resolves.toEqual([
      {
        projectId: 'p1',
        relativePath: 'src/main.ts',
        kind: 'file',
        sortOrder: 2,
        createdAt: 10,
        available: true,
      },
    ])
  })

  it('replaces a project list in its explicit order', async () => {
    const items: FavoriteItem[] = [
      {
        projectId: 'p1',
        relativePath: 'src',
        kind: 'directory',
        sortOrder: 0,
        createdAt: 10,
        available: true,
      },
      {
        projectId: 'p1',
        relativePath: 'README.md',
        kind: 'file',
        sortOrder: 1,
        createdAt: 11,
        available: false,
      },
    ]

    await replaceFavoriteItems('p1', items)

    expect(mockDb.execute).toHaveBeenNthCalledWith(
      1,
      'DELETE FROM favorite_items WHERE project_id = $1',
      ['p1'],
    )
    expect(mockDb.execute).toHaveBeenNthCalledWith(
      2,
      'INSERT INTO favorite_items (project_id, relative_path, item_type, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['p1', 'src', 'directory', 0, 10],
    )
    expect(mockDb.execute).toHaveBeenNthCalledWith(
      3,
      'INSERT INTO favorite_items (project_id, relative_path, item_type, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['p1', 'README.md', 'file', 1, 11],
    )
  })
})
