import type { FavoriteItem } from '../types'
import { withDb } from './projectRepository'

interface FavoriteRow {
  project_id: string
  relative_path: string
  item_type: 'file' | 'directory'
  sort_order: number
  created_at: number
}

function fromRow(row: FavoriteRow): FavoriteItem {
  return {
    projectId: row.project_id,
    relativePath: row.relative_path,
    kind: row.item_type,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    available: true,
  }
}

export async function loadFavoriteItems(projectId: string): Promise<FavoriteItem[]> {
  return withDb('加载收藏夹', async db => {
    const rows = await db.select<FavoriteRow[]>(
      'SELECT project_id, relative_path, item_type, sort_order, created_at FROM favorite_items WHERE project_id = $1 ORDER BY sort_order ASC, created_at ASC',
      [projectId],
    )
    return rows.map(fromRow)
  })
}

export async function insertFavoriteItem(item: FavoriteItem): Promise<void> {
  await withDb('添加收藏', db =>
    db.execute(
      'INSERT OR REPLACE INTO favorite_items (project_id, relative_path, item_type, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)',
      [item.projectId, item.relativePath, item.kind, item.sortOrder, item.createdAt],
    ).then(() => undefined),
  )
}

/** Replace one project's small ordered list after reorder/path mutations. */
export async function replaceFavoriteItems(
  projectId: string,
  items: FavoriteItem[],
): Promise<void> {
  await withDb('更新收藏夹', async db => {
    await db.execute('DELETE FROM favorite_items WHERE project_id = $1', [projectId])
    for (const item of items) {
      await db.execute(
        'INSERT INTO favorite_items (project_id, relative_path, item_type, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)',
        [projectId, item.relativePath, item.kind, item.sortOrder, item.createdAt],
      )
    }
  })
}
