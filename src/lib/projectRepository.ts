import Database from '@tauri-apps/plugin-sql'
import { safeInvoke, isTauri, NotInTauriError } from './tauri'
import type { Project, RecentFile } from '../types'
import { baseName, normalizeProjectPath } from '../utils/fileTreeHelpers'
import {
  loadGlobalSettings,
  readProjectEntries,
  shouldSyncProjectsOnStartup,
} from './projectSettings'

let dbPromise: Promise<Database> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const label = await safeInvoke<string>('数据库地址', 'db_url')
      return Database.load(label)
    })()
  }
  return dbPromise
}

const LEGACY_DATABASE_PATH = 'sqlite:../com.administrator.my-code-desktop/my_code_desktop.db'
const LEGACY_MIGRATION_KEY = 'legacy_my_code_desktop_db_v1'

/** Ensures DB access is only attempted inside Tauri; otherwise throws a friendly error. */
export async function withDb<T>(action: string, fn: (d: Database) => Promise<T>): Promise<T> {
  if (!isTauri()) throw new NotInTauriError(action)
  const d = await getDb()
  return fn(d)
}

export async function migrateLegacyProjects(db: Database): Promise<boolean> {
  const completed = await db.select<{ value: string }[]>('SELECT value FROM settings WHERE key = $1', [
    LEGACY_MIGRATION_KEY,
  ])
  if (completed.length > 0) return false

  const [{ count }] = await db.select<{ count: number }[]>('SELECT COUNT(*) AS count FROM projects')
  if (Number(count) > 0) return false

  let legacyDb: Database | null = null
  let transactionStarted = false
  try {
    legacyDb = await Database.load(LEGACY_DATABASE_PATH)
    const projects = await legacyDb.select<Project[]>(
      'SELECT id, name, path, default_shell, created_at, last_opened_at FROM projects',
    )
    const recentFiles = await legacyDb.select<RecentFile[]>(
      'SELECT project_id, path, opened_at FROM recent_files',
    )

    await db.execute('BEGIN IMMEDIATE')
    transactionStarted = true
    for (const project of projects) {
      await db.execute(
        'INSERT OR IGNORE INTO projects (id, name, path, default_shell, created_at, last_opened_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          project.id,
          project.name,
          project.path,
          project.default_shell,
          project.created_at,
          project.last_opened_at,
        ],
      )
    }
    for (const file of recentFiles) {
      await db.execute('INSERT OR IGNORE INTO recent_files (project_id, path, opened_at) VALUES ($1, $2, $3)', [
        file.project_id,
        file.path,
        file.opened_at,
      ])
    }
    await db.execute('COMMIT')
    transactionStarted = false
    await legacyDb.close()
    await db.execute('INSERT INTO settings (key, value) VALUES ($1, $2)', [LEGACY_MIGRATION_KEY, 'done'])
    return projects.length > 0
  } catch (error) {
    if (transactionStarted) {
      try {
        await db.execute('ROLLBACK')
      } catch (rollbackError) {
        console.error('Legacy migration rollback failed:', rollbackError)
      }
    }
    if (legacyDb) {
      try {
        await legacyDb.close()
      } catch (closeError) {
        console.error('Legacy database close failed:', closeError)
      }
    }
    console.info('Legacy project database is unavailable:', error)
    return false
  }
}

export async function listProjects(db: Database): Promise<Project[]> {
  return db.select<Project[]>('SELECT * FROM projects ORDER BY last_opened_at DESC')
}

export async function syncProjectsFromUserSettings(
  db: Database,
  projects: Project[],
): Promise<{ projects: Project[]; imported: number }> {
  const settings = await loadGlobalSettings()
  if (!shouldSyncProjectsOnStartup(settings)) {
    return { projects, imported: 0 }
  }
  const entries = readProjectEntries(settings)
  if (entries.length === 0) return { projects, imported: 0 }

  let imported = 0
  let next = projects

  for (const entry of entries) {
    const existing = next.find(
      project => normalizeProjectPath(project.path) === normalizeProjectPath(entry.path),
    )
    if (existing) {
      const hidden = entry.hidden ? 1 : 0
      const name = entry.name?.trim() || existing.name
      const defaultShell = entry.defaultShell ?? existing.default_shell ?? null
      const needsUpdate =
        existing.hidden !== hidden ||
        existing.name !== name ||
        (existing.default_shell ?? null) !== defaultShell
      if (!needsUpdate) continue
      await db.execute(
        'UPDATE projects SET name = $1, hidden = $2, default_shell = $3 WHERE id = $4',
        [name, hidden, defaultShell, existing.id],
      )
      next = next.map(project =>
        project.id === existing.id
          ? { ...project, name, hidden, default_shell: defaultShell ?? undefined }
          : project,
      )
      continue
    }

    try {
      await safeInvoke('检查项目目录', 'validate_directory', { path: entry.path })
      const id = crypto.randomUUID()
      const now = Date.now()
      const name = entry.name?.trim() || baseName(entry.path)
      const hidden = entry.hidden ? 1 : 0
      await db.execute(
        'INSERT INTO projects (id, name, path, default_shell, created_at, last_opened_at, hidden) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, name, entry.path, entry.defaultShell ?? null, now, now, hidden],
      )
      next = [
        {
          id,
          name,
          path: entry.path,
          default_shell: entry.defaultShell,
          created_at: now,
          last_opened_at: now,
          hidden,
        },
        ...next,
      ]
      imported += 1
    } catch {
      // Skip missing / invalid paths from settings; user can fix the JSON.
    }
  }

  return { projects: next, imported }
}

/** Load projects, running legacy migration and optional settings sync. */
export async function loadProjectsFromDb(): Promise<{
  migrated: boolean
  projects: Project[]
  importedFromSettings: number
}> {
  return withDb('加载项目列表', async d => {
    const migrated = await migrateLegacyProjects(d)
    let projects = await listProjects(d)
    let importedFromSettings = 0
    if (isTauri()) {
      try {
        const synced = await syncProjectsFromUserSettings(d, projects)
        projects = synced.projects
        importedFromSettings = synced.imported
        if (importedFromSettings > 0) {
          projects = await listProjects(d)
        }
      } catch (error) {
        console.warn('sync projects from default-settings.json failed:', error)
      }
    }
    return { migrated, projects, importedFromSettings }
  })
}

export async function insertProject(
  id: string,
  name: string,
  path: string,
  now: number,
): Promise<void> {
  await withDb('添加项目', d =>
    d.execute(
      'INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES ($1, $2, $3, $4, $5)',
      [id, name, path, now, now],
    ),
  )
}

export async function deleteProjectRows(id: string): Promise<void> {
  await withDb('移除项目', async d => {
    await d.execute('DELETE FROM projects WHERE id = $1', [id])
    await d.execute('DELETE FROM recent_files WHERE project_id = $1', [id])
  })
}

export async function setProjectHidden(id: string, hidden: 0 | 1): Promise<void> {
  await withDb(hidden ? '隐藏项目' : '显示项目', d =>
    d.execute('UPDATE projects SET hidden = $1 WHERE id = $2', [hidden, id]),
  )
}

export async function setProjectSortOrder(id: string, sortOrder: number): Promise<void> {
  await withDb('排序项目', d =>
    d.execute('UPDATE projects SET sort_order = $1 WHERE id = $2', [sortOrder, id]),
  )
}

export async function relocateProjectRows(id: string, path: string, name: string): Promise<void> {
  await withDb('重新定位项目', d =>
    Promise.all([
      d.execute('UPDATE projects SET name = $1, path = $2 WHERE id = $3', [name, path, id]),
      d.execute('DELETE FROM recent_files WHERE project_id = $1', [id]),
    ]),
  )
}

export async function renameProjectRow(id: string, name: string): Promise<void> {
  await withDb('重命名项目', d =>
    d.execute('UPDATE projects SET name = $1 WHERE id = $2', [name, id]),
  )
}

export async function touchAndLoadRecentFiles(projectId: string): Promise<RecentFile[]> {
  return withDb('切换项目', async d => {
    await d.execute('UPDATE projects SET last_opened_at = $1 WHERE id = $2', [
      Date.now(),
      projectId,
    ])
    return d.select<RecentFile[]>(
      'SELECT * FROM recent_files WHERE project_id = $1 ORDER BY opened_at DESC LIMIT 50',
      [projectId],
    )
  })
}

export async function upsertRecentFile(
  projectId: string,
  path: string,
  openedAt: number,
): Promise<void> {
  await withDb('记录最近文件', d =>
    d.execute(
      'INSERT OR REPLACE INTO recent_files (project_id, path, opened_at) VALUES ($1, $2, $3)',
      [projectId, path, openedAt],
    ),
  )
}
