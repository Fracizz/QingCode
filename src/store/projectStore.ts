import { create } from 'zustand'
import Database from '@tauri-apps/plugin-sql'
import { open } from '@tauri-apps/plugin-dialog'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import type { Project, RecentFile } from '../types'

let dbPromise: Promise<Database> | null = null
function getDb() {
  if (!dbPromise) dbPromise = Database.load('sqlite:qingcode.db')
  return dbPromise
}

const LEGACY_DATABASE_PATH = 'sqlite:../com.administrator.my-code-desktop/my_code_desktop.db'
const LEGACY_MIGRATION_KEY = 'legacy_my_code_desktop_db_v1'

async function migrateLegacyProjects(db: Database): Promise<boolean> {
  const completed = await db.select<{ value: string }[]>('SELECT value FROM settings WHERE key = $1', [
    LEGACY_MIGRATION_KEY
  ])
  if (completed.length > 0) return false

  const [{ count }] = await db.select<{ count: number }[]>('SELECT COUNT(*) AS count FROM projects')
  if (Number(count) > 0) return false

  let legacyDb: Database | null = null
  let transactionStarted = false
  try {
    legacyDb = await Database.load(LEGACY_DATABASE_PATH)
    const projects = await legacyDb.select<Project[]>(
      'SELECT id, name, path, default_shell, created_at, last_opened_at FROM projects'
    )
    const recentFiles = await legacyDb.select<RecentFile[]>('SELECT project_id, path, opened_at FROM recent_files')

    await db.execute('BEGIN IMMEDIATE')
    transactionStarted = true
    for (const project of projects) {
      await db.execute(
        'INSERT OR IGNORE INTO projects (id, name, path, default_shell, created_at, last_opened_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [project.id, project.name, project.path, project.default_shell, project.created_at, project.last_opened_at]
      )
    }
    for (const file of recentFiles) {
      await db.execute('INSERT OR IGNORE INTO recent_files (project_id, path, opened_at) VALUES ($1, $2, $3)', [
        file.project_id,
        file.path,
        file.opened_at
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

/** Ensures DB access is only attempted inside Tauri; otherwise throws a friendly error. */
async function withDb<T>(action: string, fn: (d: Database) => Promise<T>): Promise<T> {
  if (!isTauri()) throw new NotInTauriError(action)
  const d = await getDb()
  return fn(d)
}

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
  loaded?: boolean
}

export type ToastKind = 'error' | 'info' | 'success'
export interface Toast {
  id: string
  kind: ToastKind
  text: string
}

interface ProjectState {
  projects: Project[]
  currentProject: Project | null
  recentFiles: RecentFile[]
  fileTree: FileNode[]
  /** Root file tree per project, so multiple projects can be shown at once. */
  projectTrees: Record<string, FileNode[]>
  /** Which project rows are expanded in the sidebar (defaults to true). */
  expandedProjects: Record<string, boolean>
  unavailableProjectIds: string[]
  loading: boolean
  toasts: Toast[]

  loadProjects: () => Promise<void>
  addProject: (path: string) => Promise<boolean>
  addProjectFromDialog: () => Promise<void>
  removeProject: (id: string) => Promise<void>
  relocateProject: (id: string, path: string) => Promise<boolean>
  switchProject: (project: Project) => Promise<void>
  addRecentFile: (path: string) => Promise<void>
  loadFileTree: () => Promise<void>
  expandDir: (path: string) => Promise<void>
  ensureProjectTree: (project: Project) => Promise<void>
  refreshProjectTree: (project: Project) => Promise<void>
  toggleProjectExpanded: (projectId: string) => void
  expandProjectDir: (projectId: string, path: string) => Promise<void>
  pushToast: (kind: ToastKind, text: string) => void
  dismissToast: (id: string) => void
}

function baseName(p: string) {
  const norm = p.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  recentFiles: [],
  fileTree: [],
  projectTrees: {},
  expandedProjects: {},
  unavailableProjectIds: [],
  loading: false,
  toasts: [],

  pushToast: (kind, text) => {
    const id = crypto.randomUUID()
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  loadProjects: async () => {
    try {
      const { migrated, projects } = await withDb('加载项目列表', async (d) => ({
        migrated: await migrateLegacyProjects(d),
        projects: await d.select<Project[]>('SELECT * FROM projects ORDER BY last_opened_at DESC')
      }))
      if (migrated) get().pushToast('success', '已从旧版本恢复项目列表')
      const unavailableProjectIds = (
        await Promise.all(
          projects.map(async (project) => {
            try {
              await safeInvoke('检查项目目录', 'validate_directory', {
                path: project.path
              })
              return null
            } catch {
              return project.id
            }
          })
        )
      ).filter((id): id is string => id !== null)
      // Default every project to expanded so the sidebar shows a flat,
      // multi-root workspace (all projects laid out, like the reference mock).
      const expandedProjects: Record<string, boolean> = {}
      for (const p of projects) {
        expandedProjects[p.id] = get().expandedProjects[p.id] ?? true
      }
      set({
        projects,
        unavailableProjectIds,
        expandedProjects,
        loading: false
      })
      // Load each available project's root tree in parallel.
      await Promise.all(
        projects.filter((p) => !unavailableProjectIds.includes(p.id)).map((p) => get().ensureProjectTree(p))
      )
      if (projects.length > 0 && !get().currentProject) {
        const firstAvailable = projects.find((project) => !unavailableProjectIds.includes(project.id))
        if (firstAvailable) await get().switchProject(firstAvailable)
      }
    } catch (e) {
      if (e instanceof NotInTauriError) {
        set({ loading: false })
        return
      }
      console.error('loadProjects failed:', e)
      get().pushToast('error', `加载项目列表失败: ${String(e)}`)
    }
  },

  addProject: async (path: string) => {
    try {
      await safeInvoke('检查项目目录', 'validate_directory', { path })
      const name = baseName(path)
      const id = crypto.randomUUID()
      const now = Date.now()
      await withDb('添加项目', (d) =>
        d.execute('INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES ($1, $2, $3, $4, $5)', [
          id,
          name,
          path,
          now,
          now
        ])
      )
      await get().loadProjects()
      // Switch to the newly added project (it's now the most recent).
      const created = get().projects.find((p) => p.path === path)
      if (created) await get().switchProject(created)
      get().pushToast('success', `已添加项目: ${name}`)
      return true
    } catch (e) {
      console.error('addProject failed:', e)
      const msg = String(e)
      if (msg.includes('UNIQUE')) {
        get().pushToast('error', '该项目已存在')
      } else {
        get().pushToast('error', `添加项目失败: ${msg}`)
      }
      return false
    }
  },

  addProjectFromDialog: async () => {
    try {
      if (!isTauri()) throw new NotInTauriError('打开目录选择器')
      const selected = await open({ directory: true, multiple: true })
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
      if (paths.length === 0) return
      for (const p of paths) {
        await get().addProject(p)
      }
    } catch (e) {
      console.error('dialog open failed:', e)
      get().pushToast('error', `打开目录选择器失败: ${String(e)}`)
    }
  },

  removeProject: async (id: string) => {
    try {
      await withDb('移除项目', async (d) => {
        await d.execute('DELETE FROM projects WHERE id = $1', [id])
        await d.execute('DELETE FROM recent_files WHERE project_id = $1', [id])
      })
      const wasCurrent = get().currentProject?.id === id
      set((s) => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        const expandedProjects = { ...s.expandedProjects }
        delete expandedProjects[id]
        return {
          currentProject: wasCurrent ? null : s.currentProject,
          recentFiles: wasCurrent ? [] : s.recentFiles,
          fileTree: wasCurrent ? [] : s.fileTree,
          projectTrees,
          expandedProjects
        }
      })
      await get().loadProjects()
      get().pushToast('info', '已移除项目')
    } catch (e) {
      console.error('removeProject failed:', e)
      get().pushToast('error', `移除项目失败: ${String(e)}`)
    }
  },

  relocateProject: async (id: string, path: string) => {
    try {
      await safeInvoke('检查项目目录', 'validate_directory', { path })
      const wasCurrent = get().currentProject?.id === id
      // Drop the stale tree so it reloads from the new location.
      set((s) => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        return { projectTrees }
      })
      await withDb('重新定位项目', (d) =>
        d.execute('UPDATE projects SET name = $1, path = $2 WHERE id = $3', [baseName(path), path, id])
      )
      await get().loadProjects()
      const relocated = get().projects.find((project) => project.id === id)
      if (wasCurrent && relocated) await get().switchProject(relocated)
      get().pushToast('success', `项目已重新定位: ${baseName(path)}`)
      return true
    } catch (e) {
      console.error('relocateProject failed:', e)
      const message = String(e)
      get().pushToast('error', message.includes('UNIQUE') ? '该目录已被其他项目使用' : `重新定位项目失败: ${message}`)
      return false
    }
  },

  switchProject: async (project: Project) => {
    try {
      await safeInvoke('检查项目目录', 'validate_directory', {
        path: project.path
      })
      const recentFiles = await withDb('切换项目', async (d) => {
        await d.execute('UPDATE projects SET last_opened_at = $1 WHERE id = $2', [Date.now(), project.id])
        return d.select<RecentFile[]>(
          'SELECT * FROM recent_files WHERE project_id = $1 ORDER BY opened_at DESC LIMIT 50',
          [project.id]
        )
      })
      set((s) => ({
        currentProject: project,
        recentFiles,
        unavailableProjectIds: s.unavailableProjectIds.filter((id) => id !== project.id),
        expandedProjects: { ...s.expandedProjects, [project.id]: true }
      }))
      await get().ensureProjectTree(project)
    } catch (e) {
      console.error('switchProject failed:', e)
      set((s) => ({
        unavailableProjectIds: s.unavailableProjectIds.includes(project.id)
          ? s.unavailableProjectIds
          : [...s.unavailableProjectIds, project.id]
      }))
      get().pushToast('error', `切换项目失败: ${String(e)}`)
    }
  },

  addRecentFile: async (path: string) => {
    const proj = get().currentProject
    if (!proj) return
    try {
      await withDb('记录最近文件', (d) =>
        d.execute('INSERT OR REPLACE INTO recent_files (project_id, path, opened_at) VALUES ($1, $2, $3)', [
          proj.id,
          path,
          Date.now()
        ])
      )
    } catch (e) {
      console.error('addRecentFile failed:', e)
    }
  },

  loadFileTree: async () => {
    const proj = get().currentProject
    if (!proj) return
    try {
      const tree = await safeInvoke<FileNode[]>('读取目录', 'scan_directory', {
        path: proj.path
      })
      set({
        fileTree: tree.map((n) => ({ ...n, loaded: n.is_dir ? false : true }))
      })
    } catch (e) {
      console.error('loadFileTree failed:', e)
      set((s) => ({
        unavailableProjectIds:
          proj && !s.unavailableProjectIds.includes(proj.id)
            ? [...s.unavailableProjectIds, proj.id]
            : s.unavailableProjectIds
      }))
      get().pushToast('error', `读取目录失败: ${String(e)}`)
    }
  },

  expandDir: async (path: string) => {
    try {
      const children = await safeInvoke<FileNode[]>('展开目录', 'scan_directory', { path })
      set((s) => ({
        fileTree: patchTree(s.fileTree, path, () => children.map((n) => ({ ...n, loaded: n.is_dir ? false : true })))
      }))
    } catch (e) {
      console.error('expandDir failed:', e)
      get().pushToast('error', `展开目录失败: ${String(e)}`)
    }
  },

  ensureProjectTree: async (project: Project) => {
    if (get().projectTrees[project.id]) return
    try {
      const tree = await safeInvoke<FileNode[]>('读取目录', 'scan_directory', {
        path: project.path
      })
      set((s) => ({
        projectTrees: {
          ...s.projectTrees,
          [project.id]: tree.map((n) => ({
            ...n,
            loaded: n.is_dir ? false : true
          }))
        },
        unavailableProjectIds: s.unavailableProjectIds.filter((id) => id !== project.id)
      }))
    } catch (e) {
      console.error('ensureProjectTree failed:', e)
      set((s) => ({
        unavailableProjectIds: s.unavailableProjectIds.includes(project.id)
          ? s.unavailableProjectIds
          : [...s.unavailableProjectIds, project.id]
      }))
      get().pushToast('error', `读取目录失败: ${String(e)}`)
    }
  },

  refreshProjectTree: async (project: Project) => {
    try {
      const tree = await safeInvoke<FileNode[]>('读取目录', 'scan_directory', {
        path: project.path
      })
      set((s) => ({
        projectTrees: {
          ...s.projectTrees,
          [project.id]: tree.map((n) => ({
            ...n,
            loaded: n.is_dir ? false : true
          }))
        },
        unavailableProjectIds: s.unavailableProjectIds.filter((id) => id !== project.id)
      }))
    } catch (e) {
      console.error('refreshProjectTree failed:', e)
      get().pushToast('error', `刷新目录失败: ${String(e)}`)
    }
  },

  toggleProjectExpanded: (projectId: string) =>
    set((s) => ({
      expandedProjects: {
        ...s.expandedProjects,
        [projectId]: !(s.expandedProjects[projectId] ?? true)
      }
    })),

  expandProjectDir: async (projectId: string, path: string) => {
    try {
      const children = await safeInvoke<FileNode[]>('展开目录', 'scan_directory', { path })
      set((s) => {
        const tree = s.projectTrees[projectId] ?? []
        return {
          projectTrees: {
            ...s.projectTrees,
            [projectId]: patchTree(tree, path, () => children.map((n) => ({ ...n, loaded: n.is_dir ? false : true })))
          }
        }
      })
    } catch (e) {
      console.error('expandProjectDir failed:', e)
      get().pushToast('error', `展开目录失败: ${String(e)}`)
    }
  }
}))

function patchTree(
  nodes: FileNode[],
  targetPath: string,
  updater: (existing: FileNode[] | undefined) => FileNode[]
): FileNode[] {
  return nodes.map((n) => {
    if (n.path === targetPath) {
      const children = updater(n.children)
      return { ...n, children, loaded: true }
    }
    if (n.children) {
      return { ...n, children: patchTree(n.children, targetPath, updater) }
    }
    return n
  })
}
