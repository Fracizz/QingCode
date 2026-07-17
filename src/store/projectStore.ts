import { create } from 'zustand'
import Database from '@tauri-apps/plugin-sql'
import { open } from '@tauri-apps/plugin-dialog'
import { tempDir } from '@tauri-apps/api/path'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import type { Project, RecentFile } from '../types'
import { collectAncestorDirs, findProjectForPath } from '../utils/fileReferences'
import {
  baseName,
  normalizeProjectPath,
  patchTree,
  type FileNode,
} from '../utils/fileTreeHelpers'
import { useEditorStore } from './editorStore'
import {
  loadGlobalSettings,
  readProjectEntries,
  shouldSyncProjectsOnStartup,
} from '../lib/projectSettings'
import { translate } from '../lib/i18n'
import { shouldRestoreWorkspace } from '../lib/windowSession'

export type { FileNode }

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

export type ToastKind = 'error' | 'info' | 'success'
export interface Toast {
  id: string
  kind: ToastKind
  text: string
  detail?: string
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
  /** File path to reveal/highlight in the sidebar tree. */
  treeRevealPath: string | null
  unavailableProjectIds: string[]
  loading: boolean
  toasts: Toast[]

  loadProjects: () => Promise<void>
  addProject: (path: string) => Promise<boolean>
  addProjectFromDialog: () => Promise<void>
  addEmptyProject: () => Promise<boolean>
  addTerminalProject: (name: string) => Promise<boolean>
  removeProject: (id: string) => Promise<void>
  hideProject: (id: string) => Promise<void>
  unhideProject: (id: string) => Promise<void>
  /** Persist a manual sort order for a project (used by the project manager). */
  setProjectSortOrder: (id: string, sortOrder: number) => Promise<void>
  relocateProject: (id: string, path: string) => Promise<boolean>
  renameProject: (id: string, name: string) => Promise<void>
  /** @returns false if the user cancelled dirty-tab confirmation or activation failed */
  switchProject: (project: Project) => Promise<boolean>
  addRecentFile: (path: string) => Promise<void>
  loadFileTree: () => Promise<void>
  expandDir: (path: string) => Promise<void>
  ensureProjectTree: (project: Project) => Promise<void>
  refreshProjectTree: (project: Project) => Promise<void>
  toggleProjectExpanded: (projectId: string) => void
  expandProjectDir: (projectId: string, path: string) => Promise<void>
  revealFileInTree: (filePath: string) => Promise<void>
  pushToast: (kind: ToastKind, text: string, detail?: string) => void
  dismissToast: (id: string) => void
}

async function syncProjectsFromUserSettings(
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

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  recentFiles: [],
  fileTree: [],
  projectTrees: {},
  expandedProjects: {},
  treeRevealPath: null,
  unavailableProjectIds: [],
  loading: false,
  toasts: [],

  pushToast: (kind, text, detail) => {
    const normalizedDetail = detail?.trim() || undefined
    const duplicate = get().toasts.some(
      t => t.kind === kind && t.text === text && (t.detail ?? '') === (normalizedDetail ?? '')
    )
    if (duplicate) return

    const id = crypto.randomUUID()
    set(s => ({
      toasts: [...s.toasts, { id, kind, text, detail: normalizedDetail }],
    }))
    setTimeout(() => get().dismissToast(id), normalizedDetail ? 6000 : 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  loadProjects: async () => {
    try {
      const { migrated, projects, importedFromSettings } = await withDb(
        '加载项目列表',
        async (d) => {
          const migrated = await migrateLegacyProjects(d)
          let projects = await d.select<Project[]>(
            'SELECT * FROM projects ORDER BY last_opened_at DESC',
          )
          let importedFromSettings = 0
          if (isTauri()) {
            try {
              const synced = await syncProjectsFromUserSettings(d, projects)
              projects = synced.projects
              importedFromSettings = synced.imported
              if (importedFromSettings > 0) {
                projects = await d.select<Project[]>(
                  'SELECT * FROM projects ORDER BY last_opened_at DESC',
                )
              }
            } catch (error) {
              console.warn('sync projects from default-settings.json failed:', error)
            }
          }
          return { migrated, projects, importedFromSettings }
        },
      )
      if (migrated) get().pushToast('success', '已从旧版本恢复项目列表')
      if (importedFromSettings > 0) {
        get().pushToast(
          'success',
          translate('已从用户设置同步 {count} 个项目', { count: importedFromSettings }),
        )
      }

      const expandedProjects: Record<string, boolean> = {}
      const ephemeralProjects = get().projects.filter((p) => p.ephemeral)
      for (const p of [...projects, ...ephemeralProjects]) {
        expandedProjects[p.id] = get().expandedProjects[p.id] ?? true
      }

      set({
        projects: [...ephemeralProjects, ...projects],
        unavailableProjectIds: [],
        expandedProjects,
        loading: false
      })

      // Main window: open the most recent project immediately so the UI is not
      // gated on validating every path. Fresh windows (File → New Window) stay
      // empty — no inherited currentProject / explorer / auto terminal.
      const restoreWorkspace = shouldRestoreWorkspace()
      if (restoreWorkspace && !get().currentProject) {
        const candidate =
          projects.find((project) => !project.hidden) ??
          ephemeralProjects.find((project) => !project.hidden)
        if (candidate) void get().switchProject(candidate)
      }

      void (async () => {
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

        set({ unavailableProjectIds })

        if (!restoreWorkspace) return

        const pickAvailable = () => {
          const all = get().projects
          return (
            all.find(
              (project) =>
                !project.hidden &&
                !unavailableProjectIds.includes(project.id) &&
                !project.ephemeral,
            ) ??
            all.find(
              (project) => !project.hidden && !unavailableProjectIds.includes(project.id),
            )
          )
        }

        const current = get().currentProject
        if (current && unavailableProjectIds.includes(current.id)) {
          const firstAvailable = pickAvailable()
          if (firstAvailable) {
            await get().switchProject(firstAvailable)
          } else {
            set({ currentProject: null, recentFiles: [] })
          }
        } else if (!current) {
          const firstAvailable = pickAvailable()
          if (firstAvailable) await get().switchProject(firstAvailable)
        }
      })()
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

  addEmptyProject: async () => {
    if (!isTauri()) throw new NotInTauriError('新增空项目')
    try {
      const temp = await tempDir()
      const id = crypto.randomUUID()
      const dirName = `qingcode-empty-${id}`
      const path = await safeInvoke<string>('创建空项目目录', 'create_directory', {
        parent: temp,
        name: dirName,
      })

      const existingNames = new Set(get().projects.map((p) => p.name))
      let index = 1
      let name = '空项目'
      while (existingNames.has(name)) {
        index += 1
        name = `空项目 ${index}`
      }

      const now = Date.now()
      const project: Project = {
        id,
        name,
        path,
        created_at: now,
        last_opened_at: now,
        ephemeral: true,
      }

      // Ephemeral projects live only in memory; they are not written to the
      // projects table and disappear after restart. Set currentProject in the
      // same update so explorer/terminal are never left without an active project.
      const previousId = get().currentProject?.id ?? null
      set((s) => ({
        projects: [project, ...s.projects],
        currentProject: project,
        recentFiles: [],
        unavailableProjectIds: s.unavailableProjectIds.filter((pid) => pid !== id),
        expandedProjects: { ...s.expandedProjects, [id]: true },
      }))
      useEditorStore.getState().activateProjectSession(previousId, id)
      void get().ensureProjectTree(project)
      get().pushToast('success', `已新增空项目: ${name}（临时，重启后消失）`)
      return true
    } catch (e) {
      console.error('addEmptyProject failed:', e)
      get().pushToast('error', `新增空项目失败: ${String(e)}`)
      return false
    }
  },

  addTerminalProject: async (name: string) => {
    if (!isTauri()) throw new NotInTauriError('新建终端项目')
    try {
      const temp = await tempDir()
      const id = crypto.randomUUID()
      const dirName = `qingcode-terminal-${id}`
      const path = await safeInvoke<string>('创建终端项目目录', 'create_directory', {
        parent: temp,
        name: dirName,
      })
      const now = Date.now()
      await withDb('新建终端项目', (d) =>
        d.execute(
          'INSERT INTO projects (id, name, path, created_at, last_opened_at) VALUES ($1, $2, $3, $4, $5)',
          [id, name, path, now, now],
        ),
      )
      await get().loadProjects()
      const created = get().projects.find((p) => p.id === id)
      if (created) await get().switchProject(created)
      get().pushToast('success', `已新建终端项目: ${name}`)
      return true
    } catch (e) {
      console.error('addTerminalProject failed:', e)
      get().pushToast('error', `新建终端项目失败: ${String(e)}`)
      return false
    }
  },

  removeProject: async (id: string) => {
    const target = get().projects.find((p) => p.id === id)
    if (target?.ephemeral) {
      const wasCurrent = get().currentProject?.id === id
      set((s) => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        const expandedProjects = { ...s.expandedProjects }
        delete expandedProjects[id]
        return {
          projects: s.projects.filter((p) => p.id !== id),
          currentProject: wasCurrent ? null : s.currentProject,
          recentFiles: wasCurrent ? [] : s.recentFiles,
          fileTree: wasCurrent ? [] : s.fileTree,
          projectTrees,
          expandedProjects
        }
      })
      get().pushToast('info', '已移除临时项目')
      return
    }
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

  hideProject: async (id: string) => {
    const target = get().projects.find((p) => p.id === id)
    if (target?.ephemeral) {
      const wasCurrent = get().currentProject?.id === id
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, hidden: 1 } : p)),
      }))
      if (wasCurrent) {
        const unavailable = get().unavailableProjectIds
        const next = get().projects.find(
          (p) => !p.hidden && !unavailable.includes(p.id) && p.id !== id,
        )
        if (next) {
          await get().switchProject(next)
        } else {
          set({ currentProject: null, recentFiles: [], fileTree: [] })
        }
      }
      get().pushToast('info', '已从顶栏隐藏')
      return
    }
    try {
      await withDb('隐藏项目', (d) =>
        d.execute('UPDATE projects SET hidden = 1 WHERE id = $1', [id]),
      )
      const wasCurrent = get().currentProject?.id === id
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, hidden: 1 } : p)),
      }))
      if (wasCurrent) {
        const unavailable = get().unavailableProjectIds
        const next = get().projects.find(
          (p) => !p.hidden && !unavailable.includes(p.id) && p.id !== id,
        )
        if (next) {
          await get().switchProject(next)
        } else {
          set({ currentProject: null, recentFiles: [], fileTree: [] })
        }
      }
      get().pushToast('info', '已从顶栏隐藏，可在项目管理中恢复')
    } catch (e) {
      console.error('hideProject failed:', e)
      get().pushToast('error', `隐藏项目失败: ${String(e)}`)
    }
  },

  unhideProject: async (id: string) => {
    const target = get().projects.find((p) => p.id === id)
    if (target?.ephemeral) {
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, hidden: 0 } : p)),
      }))
      get().pushToast('success', '已恢复显示')
      return
    }
    try {
      await withDb('显示项目', (d) =>
        d.execute('UPDATE projects SET hidden = 0 WHERE id = $1', [id]),
      )
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, hidden: 0 } : p)),
      }))
      get().pushToast('success', '已恢复显示')
    } catch (e) {
      console.error('unhideProject failed:', e)
      get().pushToast('error', `恢复项目失败: ${String(e)}`)
    }
  },

  setProjectSortOrder: async (id: string, sortOrder: number) => {
    const target = get().projects.find((p) => p.id === id)
    if (target?.ephemeral) {
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, sort_order: sortOrder } : p,
        ),
      }))
      return
    }
    try {
      await withDb('排序项目', (d) =>
        d.execute('UPDATE projects SET sort_order = $1 WHERE id = $2', [sortOrder, id]),
      )
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === id ? { ...p, sort_order: sortOrder } : p,
        ),
      }))
    } catch (e) {
      console.error('setProjectSortOrder failed:', e)
      get().pushToast('error', `排序项目失败: ${String(e)}`)
    }
  },

  relocateProject: async (id: string, path: string) => {
    try {
      await safeInvoke('检查项目目录', 'validate_directory', { path })
      const target = get().projects.find((project) => project.id === id)
      const wasCurrent = get().currentProject?.id === id
      const previousPath = target?.path
      // Drop the stale tree so it reloads from the new location.
      set((s) => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        return { projectTrees }
      })
      if (target?.ephemeral) {
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, name: baseName(path), path } : p,
          ),
        }))
        if (previousPath) useEditorStore.getState().renamePath(previousPath, path)
        if (wasCurrent) {
          const relocated = get().projects.find((project) => project.id === id)
          if (relocated) await get().switchProject(relocated)
        }
        get().pushToast('success', `项目已重新定位: ${baseName(path)}`)
        return true
      }
      await withDb('重新定位项目', (d) =>
        Promise.all([
          d.execute('UPDATE projects SET name = $1, path = $2 WHERE id = $3', [baseName(path), path, id]),
          d.execute('DELETE FROM recent_files WHERE project_id = $1', [id]),
        ])
      )
      if (previousPath) useEditorStore.getState().renamePath(previousPath, path)
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

  renameProject: async (id: string, name: string) => {
    const target = get().projects.find((p) => p.id === id)
    if (target?.ephemeral) {
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
        currentProject: s.currentProject?.id === id ? { ...s.currentProject, name } : s.currentProject,
      }))
      get().pushToast('success', `已重命名为: ${name}`)
      return
    }
    try {
      await withDb('重命名项目', (d) =>
        d.execute('UPDATE projects SET name = $1 WHERE id = $2', [name, id]),
      )
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
        currentProject: s.currentProject?.id === id ? { ...s.currentProject, name } : s.currentProject,
      }))
      get().pushToast('success', `已重命名为: ${name}`)
    } catch (e) {
      console.error('renameProject failed:', e)
      get().pushToast('error', `重命名项目失败: ${String(e)}`)
    }
  },

  switchProject: async (project: Project) => {
    try {
      const currentProject = get().currentProject
      if (currentProject?.id === project.id) {
        void get().ensureProjectTree(project)
        return true
      }

      // Ephemeral/empty projects use a scratch temp directory; do not block
      // activation on validate so terminals remain usable.
      if (!project.ephemeral) {
        await safeInvoke('检查项目目录', 'validate_directory', {
          path: project.path
        })
      }
      let recentFiles: RecentFile[] = []
      if (!project.ephemeral) {
        recentFiles = await withDb('切换项目', async (d) => {
          await d.execute('UPDATE projects SET last_opened_at = $1 WHERE id = $2', [Date.now(), project.id])
          return d.select<RecentFile[]>(
            'SELECT * FROM recent_files WHERE project_id = $1 ORDER BY opened_at DESC LIMIT 50',
            [project.id]
          )
        })
      }
      const previousId = currentProject?.id ?? null
      set((s) => ({
        currentProject: project,
        recentFiles,
        unavailableProjectIds: s.unavailableProjectIds.filter((id) => id !== project.id),
        expandedProjects: { ...s.expandedProjects, [project.id]: true }
      }))
      // Keep the previous project's tabs/drafts/CM state; restore the target's.
      useEditorStore.getState().activateProjectSession(previousId, project.id)
      // Load the tree after the project switch paints; callers should not wait on I/O.
      void get().ensureProjectTree(project)
      return true
    } catch (e) {
      console.error('switchProject failed:', e)
      set((s) => ({
        unavailableProjectIds: s.unavailableProjectIds.includes(project.id)
          ? s.unavailableProjectIds
          : [...s.unavailableProjectIds, project.id]
      }))
      get().pushToast('error', `切换项目失败: ${String(e)}`)
      return false
    }
  },

  addRecentFile: async (path: string) => {
    const proj = get().currentProject
    if (!proj) return
    if (proj.ephemeral) return
    const openedAt = Date.now()
    try {
      await withDb('记录最近文件', (d) =>
        d.execute('INSERT OR REPLACE INTO recent_files (project_id, path, opened_at) VALUES ($1, $2, $3)', [
          proj.id,
          path,
          openedAt
        ])
      )
      set(s => {
        if (s.currentProject?.id !== proj.id) return s
        const next: RecentFile = { project_id: proj.id, path, opened_at: openedAt }
        const rest = s.recentFiles.filter(f => f.path !== path)
        return { recentFiles: [next, ...rest].slice(0, 50) }
      })
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
  },

  revealFileInTree: async (filePath: string) => {
    const project = findProjectForPath(get().projects, filePath)
    if (!project) return

    set((s) => ({
      treeRevealPath: filePath,
      expandedProjects: { ...s.expandedProjects, [project.id]: true }
    }))

    await get().ensureProjectTree(project)

    for (const dir of collectAncestorDirs(filePath, project.path)) {
      await get().expandProjectDir(project.id, dir)
    }
  }
}))
