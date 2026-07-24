import { create } from 'zustand'
import { open } from '@tauri-apps/plugin-dialog'
import { tempDir } from '@tauri-apps/api/path'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import type { Project, RecentFile } from '../types'
import { baseName, findNodeByPath } from '../utils/fileTreeHelpers'
import { activateProjectSession, renameEditorPaths } from './editorSessionBridge'
import { translate } from '../lib/i18n'
import {
  formatExpandDirErrorToast,
  formatReadDirErrorToast,
  formatRefreshDirErrorToast,
  isDirectoryUnavailableError,
} from '../lib/directoryError'
import { shouldRestoreWorkspace } from '../lib/windowSession'
import {
  deleteProjectRows,
  insertProject,
  loadProjectsFromDb,
  persistProjectsToUserSettings,
  relocateProjectRows,
  renameProjectRow,
  setProjectHidden,
  setProjectSortOrder as persistSortOrder,
  touchAndLoadRecentFiles,
  upsertRecentFile,
} from '../lib/projectRepository'
import {
  buildExpandedProjectsMap,
  createEphemeralProject,
  mergeProjectsWithEphemeral,
  nextEmptyProjectName,
  pickAvailableProject,
  pickRestoreCandidate,
} from '../lib/workspaceSession'
import {
  dirsToReveal,
  findOwningProject,
  loadDirChildren,
  loadProjectRootTree,
  patchDirChildren,
  preserveLoadedChildren,
  reloadLoadedChildren,
  removeNodeFromTree,
  revealNeedsTreeLoad,
  type FileNode,
} from '../lib/fileTreeCache'
import { authorizePaths, syncRootsFromProjects } from '../lib/pathAllowlist'
import { ensureWorkspaceTrust, pushTrustedRootsToNative } from '../lib/workspaceTrust'

export type { FileNode }

export type ToastKind = 'error' | 'info' | 'success' | 'warn'
export interface Toast {
  id: string
  kind: ToastKind
  text: string
  detail?: string
  action?: {
    label: string
    onAction: () => void | Promise<void>
  }
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
  /** Increments on every reveal so Sidebar can re-scroll/expand even for the same path. */
  treeRevealSeq: number
  unavailableProjectIds: string[]
  loading: boolean
  toasts: Toast[]

  loadProjects: () => Promise<void>
  addProject: (path: string) => Promise<boolean>
  addProjectFromDialog: () => Promise<void>
  addEmptyProject: () => Promise<boolean>
  removeProject: (id: string) => Promise<void>
  hideProject: (id: string) => Promise<void>
  /** Hide the given project ids from the title bar (batch). Prefer switching to `keepId` if current is hidden. */
  hideProjectsByIds: (ids: string[], keepId?: string) => Promise<void>
  /** Hide every visible title-bar project except `keepId`. */
  hideOtherProjects: (keepId: string) => Promise<void>
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
  expandProjectDir: (
    projectId: string,
    path: string,
    options?: { force?: boolean }
  ) => Promise<void>
  revealFileInTree: (filePath: string, options?: { force?: boolean }) => Promise<void>
  pushToast: (kind: ToastKind, text: string, detail?: string, action?: Toast['action']) => void
  dismissToast: (id: string) => void
}

/** Latest refresh request per project; older scans must not overwrite newer state. */
const projectTreeRefreshSequences = new Map<string, number>()

function nextProjectTreeRefreshSequence(projectId: string): number {
  const next = (projectTreeRefreshSequences.get(projectId) ?? 0) + 1
  projectTreeRefreshSequences.set(projectId, next)
  return next
}

function isLatestProjectTreeRefresh(projectId: string, sequence: number): boolean {
  return projectTreeRefreshSequences.get(projectId) === sequence
}

async function syncAllowlistRoots(projects: Project[]): Promise<void> {
  try {
    await syncRootsFromProjects(projects)
    await pushTrustedRootsToNative(projects)
  } catch (error) {
    console.warn('sync project roots to path allowlist failed:', error)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry briefly — Windows can flap `is_dir` under AV / indexer load. */
async function validateDirectoryWithRetry(path: string): Promise<boolean> {
  const delaysMs = [0, 50, 100]
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) await sleep(delaysMs[i])
    try {
      await safeInvoke('检查项目目录', 'validate_directory', { path })
      return true
    } catch {
      // try again
    }
  }
  return false
}

function withUnavailableProject(ids: string[], projectId: string, unavailable: boolean): string[] {
  if (unavailable) {
    return ids.includes(projectId) ? ids : [...ids, projectId]
  }
  return ids.filter(id => id !== projectId)
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  recentFiles: [],
  fileTree: [],
  projectTrees: {},
  expandedProjects: {},
  treeRevealPath: null,
  treeRevealSeq: 0,
  unavailableProjectIds: [],
  loading: false,
  toasts: [],

  pushToast: (kind, text, detail, action) => {
    const normalizedDetail = detail?.trim() || undefined
    const duplicate = get().toasts.some(
      t => t.kind === kind && t.text === text && (t.detail ?? '') === (normalizedDetail ?? '')
    )
    if (duplicate) return

    const id = crypto.randomUUID()
    set(s => ({
      toasts: [...s.toasts, { id, kind, text, detail: normalizedDetail, action }],
    }))
    setTimeout(() => get().dismissToast(id), action ? 8000 : normalizedDetail ? 6000 : 4000)
  },
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  loadProjects: async () => {
    try {
      const { migrated, projects, importedFromSettings } = await loadProjectsFromDb()
      if (migrated) get().pushToast('success', '已从旧版本恢复项目列表')
      if (importedFromSettings > 0) {
        get().pushToast(
          'success',
          translate('已从用户设置同步 {count} 个项目', { count: importedFromSettings })
        )
      }

      const ephemeralProjects = get().projects.filter(p => p.ephemeral)
      const merged = mergeProjectsWithEphemeral(projects, ephemeralProjects)
      const expandedProjects = buildExpandedProjectsMap(merged, get().expandedProjects)

      set({
        projects: merged,
        unavailableProjectIds: [],
        expandedProjects,
        loading: false,
      })
      // Await so draft recovery / tree load do not race an empty allowlist.
      await syncAllowlistRoots(merged)

      // Main window: open the most recent project immediately so the UI is not
      // gated on validating every path. Fresh windows (File → New Window) stay
      // empty — no inherited currentProject / explorer / auto terminal.
      const restoreWorkspace = shouldRestoreWorkspace()
      if (restoreWorkspace && !get().currentProject) {
        const candidate = pickRestoreCandidate(projects, ephemeralProjects)
        if (candidate) void get().switchProject(candidate)
      }

      void (async () => {
        const results = await Promise.all(
          projects.map(async project => ({
            id: project.id,
            ok: await validateDirectoryWithRetry(project.path),
          }))
        )

        // Merge per-id so parallel switchProject clears are not wiped.
        set(s => {
          let next = s.unavailableProjectIds
          for (const { id, ok } of results) {
            next = withUnavailableProject(next, id, !ok)
          }
          return { unavailableProjectIds: next }
        })

        if (!restoreWorkspace) return

        const unavailable = get().unavailableProjectIds
        const current = get().currentProject
        if (current && unavailable.includes(current.id)) {
          const firstAvailable = pickAvailableProject(get().projects, unavailable)
          if (firstAvailable) {
            await get().switchProject(firstAvailable)
          } else {
            set({ currentProject: null, recentFiles: [] })
          }
        } else if (!current) {
          const firstAvailable = pickAvailableProject(get().projects, unavailable)
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
      // Ask trust before writing the project into the list / top bar.
      const trust = await ensureWorkspaceTrust({ id, name, path })
      if (trust === false) return false
      await insertProject(id, name, path, now)
      await get().loadProjects()
      void persistProjectsToUserSettings()
      const created = get().projects.find(p => p.id === id)
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
    if (!isTauri()) throw new NotInTauriError('新建临时项目')
    try {
      const temp = await tempDir()
      const id = crypto.randomUUID()
      const dirName = `qingcode-empty-${id}`
      const separator = temp.includes('\\') && !temp.includes('/') ? '\\' : '/'
      const intended = `${temp.replace(/[\\/]+$/, '')}${separator}${dirName}`
      await authorizePaths([intended, temp])
      const path = await safeInvoke<string>('创建临时项目目录', 'create_directory', {
        parent: temp,
        name: dirName,
      })

      const name = nextEmptyProjectName(get().projects.map(p => p.name))
      const project = createEphemeralProject({ id, name, path })

      // Ephemeral projects live only in memory; they are not written to the
      // projects table and disappear after restart. Set currentProject in the
      // same update so explorer/terminal are never left without an active project.
      const previousId = get().currentProject?.id ?? null
      set(s => ({
        projects: [project, ...s.projects],
        currentProject: project,
        recentFiles: [],
        unavailableProjectIds: s.unavailableProjectIds.filter(pid => pid !== id),
        expandedProjects: { ...s.expandedProjects, [id]: true },
      }))
      void syncAllowlistRoots(get().projects)
      activateProjectSession(previousId, id)
      void get().ensureProjectTree(project)
      get().pushToast(
        'success',
        `已新建临时项目: ${name}（退出后将从列表移除；文件保留在系统临时目录）`
      )
      return true
    } catch (e) {
      console.error('addEmptyProject failed:', e)
      get().pushToast('error', `新建临时项目失败: ${String(e)}`)
      return false
    }
  },

  removeProject: async (id: string) => {
    const target = get().projects.find(p => p.id === id)
    if (target?.ephemeral) {
      const wasCurrent = get().currentProject?.id === id
      set(s => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        const expandedProjects = { ...s.expandedProjects }
        delete expandedProjects[id]
        return {
          projects: s.projects.filter(p => p.id !== id),
          currentProject: wasCurrent ? null : s.currentProject,
          recentFiles: wasCurrent ? [] : s.recentFiles,
          fileTree: wasCurrent ? [] : s.fileTree,
          projectTrees,
          expandedProjects,
        }
      })
      void syncAllowlistRoots(get().projects)
      get().pushToast('info', '已从列表移除临时项目；文件保留在系统临时目录')
      return
    }
    try {
      await deleteProjectRows(id)
      const wasCurrent = get().currentProject?.id === id
      set(s => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        const expandedProjects = { ...s.expandedProjects }
        delete expandedProjects[id]
        return {
          currentProject: wasCurrent ? null : s.currentProject,
          recentFiles: wasCurrent ? [] : s.recentFiles,
          fileTree: wasCurrent ? [] : s.fileTree,
          projectTrees,
          expandedProjects,
        }
      })
      await get().loadProjects()
      void persistProjectsToUserSettings()
      get().pushToast('info', '已移除项目')
    } catch (e) {
      console.error('removeProject failed:', e)
      get().pushToast('error', `移除项目失败: ${String(e)}`)
    }
  },

  hideProject: async (id: string) => {
    const target = get().projects.find(p => p.id === id)
    if (target?.ephemeral) {
      const wasCurrent = get().currentProject?.id === id
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, hidden: 1 } : p)),
      }))
      if (wasCurrent) {
        const unavailable = get().unavailableProjectIds
        const next = pickAvailableProject(
          get().projects.filter(p => p.id !== id),
          unavailable
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
      await setProjectHidden(id, 1)
      void persistProjectsToUserSettings()
      const wasCurrent = get().currentProject?.id === id
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, hidden: 1 } : p)),
      }))
      if (wasCurrent) {
        const unavailable = get().unavailableProjectIds
        const next = pickAvailableProject(
          get().projects.filter(p => p.id !== id),
          unavailable
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

  hideProjectsByIds: async (ids: string[], keepId?: string) => {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return

    const targets = get().projects.filter(p => !p.hidden && unique.includes(p.id))
    if (targets.length === 0) return

    const ephemeralIds = new Set(targets.filter(p => p.ephemeral).map(p => p.id))
    const persisted = targets.filter(p => !p.ephemeral)
    const hideIds = new Set(targets.map(p => p.id))

    try {
      for (const project of persisted) {
        await setProjectHidden(project.id, 1)
      }
      if (persisted.length > 0) void persistProjectsToUserSettings()

      set(s => ({
        projects: s.projects.map(p => (hideIds.has(p.id) ? { ...p, hidden: 1 } : p)),
      }))

      const currentId = get().currentProject?.id
      if (currentId && hideIds.has(currentId)) {
        const unavailable = get().unavailableProjectIds
        const keep =
          keepId && !hideIds.has(keepId)
            ? get().projects.find(p => p.id === keepId && !p.hidden)
            : undefined
        const next =
          keep && !unavailable.includes(keep.id)
            ? keep
            : pickAvailableProject(get().projects, unavailable)
        if (next) {
          await get().switchProject(next)
        } else {
          set({ currentProject: null, recentFiles: [], fileTree: [] })
        }
      }

      get().pushToast(
        'info',
        ephemeralIds.size === targets.length
          ? translate('已关闭其他项目')
          : translate('已关闭其他项目，可在项目管理中恢复'),
      )
    } catch (e) {
      console.error('hideProjectsByIds failed:', e)
      get().pushToast('error', translate('关闭其他项目失败: {error}', { error: String(e) }))
    }
  },

  hideOtherProjects: async (keepId: string) => {
    const others = get().projects
      .filter(p => !p.hidden && p.id !== keepId)
      .map(p => p.id)
    await get().hideProjectsByIds(others, keepId)
  },

  unhideProject: async (id: string) => {
    const target = get().projects.find(p => p.id === id)
    if (target?.ephemeral) {
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, hidden: 0 } : p)),
      }))
      get().pushToast('success', '已恢复显示')
      return
    }
    try {
      await setProjectHidden(id, 0)
      void persistProjectsToUserSettings()
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, hidden: 0 } : p)),
      }))
      get().pushToast('success', '已恢复显示')
    } catch (e) {
      console.error('unhideProject failed:', e)
      get().pushToast('error', `恢复项目失败: ${String(e)}`)
    }
  },

  setProjectSortOrder: async (id: string, sortOrder: number) => {
    const target = get().projects.find(p => p.id === id)
    if (target?.ephemeral) {
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, sort_order: sortOrder } : p)),
      }))
      return
    }
    try {
      await persistSortOrder(id, sortOrder)
      void persistProjectsToUserSettings()
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, sort_order: sortOrder } : p)),
      }))
    } catch (e) {
      console.error('setProjectSortOrder failed:', e)
      get().pushToast('error', `排序项目失败: ${String(e)}`)
    }
  },

  relocateProject: async (id: string, path: string) => {
    try {
      await safeInvoke('检查项目目录', 'validate_directory', { path })
      const target = get().projects.find(project => project.id === id)
      const wasCurrent = get().currentProject?.id === id
      const previousPath = target?.path
      // Drop the stale tree so it reloads from the new location.
      set(s => {
        const projectTrees = { ...s.projectTrees }
        delete projectTrees[id]
        return { projectTrees }
      })
      if (target?.ephemeral) {
        set(s => ({
          projects: s.projects.map(p => (p.id === id ? { ...p, name: baseName(path), path } : p)),
        }))
        void syncAllowlistRoots(get().projects)
        if (previousPath) renameEditorPaths(previousPath, path)
        if (wasCurrent) {
          const relocated = get().projects.find(project => project.id === id)
          if (relocated) await get().switchProject(relocated)
        }
        get().pushToast('success', `项目已重新定位: ${baseName(path)}`)
        return true
      }
      await relocateProjectRows(id, path, baseName(path))
      if (previousPath) renameEditorPaths(previousPath, path)
      await get().loadProjects()
      void persistProjectsToUserSettings()
      const relocated = get().projects.find(project => project.id === id)
      if (wasCurrent && relocated) await get().switchProject(relocated)
      get().pushToast('success', `项目已重新定位: ${baseName(path)}`)
      return true
    } catch (e) {
      console.error('relocateProject failed:', e)
      const message = String(e)
      get().pushToast(
        'error',
        message.includes('UNIQUE') ? '该目录已被其他项目使用' : `重新定位项目失败: ${message}`
      )
      return false
    }
  },

  renameProject: async (id: string, name: string) => {
    const target = get().projects.find(p => p.id === id)
    if (target?.ephemeral) {
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, name } : p)),
        currentProject:
          s.currentProject?.id === id ? { ...s.currentProject, name } : s.currentProject,
      }))
      get().pushToast('success', `已重命名为: ${name}`)
      return
    }
    try {
      await renameProjectRow(id, name)
      void persistProjectsToUserSettings()
      set(s => ({
        projects: s.projects.map(p => (p.id === id ? { ...p, name } : p)),
        currentProject:
          s.currentProject?.id === id ? { ...s.currentProject, name } : s.currentProject,
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
        // Fast re-click: still refresh so inactive-window tree drift is visible.
        if (project.ephemeral) void get().ensureProjectTree(project)
        else void get().refreshProjectTree(project)
        return true
      }

      // VS Code–style workspace trust: ask once before activating the project.
      const trust = await ensureWorkspaceTrust(project)
      if (trust === false) return false
      const known = get().projects
      const forTrustSync = known.some(p => p.id === project.id) ? known : [...known, project]
      await pushTrustedRootsToNative(forTrustSync)

      // Ephemeral/empty projects use a scratch temp directory; do not block
      // activation on validate so terminals remain usable.
      if (!project.ephemeral) {
        await safeInvoke('检查项目目录', 'validate_directory', {
          path: project.path,
        })
      }
      let recentFiles: RecentFile[] = []
      if (!project.ephemeral) {
        recentFiles = await touchAndLoadRecentFiles(project.id)
      }
      const previousId = currentProject?.id ?? null
      set(s => ({
        currentProject: project,
        recentFiles,
        unavailableProjectIds: s.unavailableProjectIds.filter(id => id !== project.id),
        expandedProjects: { ...s.expandedProjects, [project.id]: true },
      }))
      // Keep the previous project's tabs/drafts/CM state; restore the target's.
      activateProjectSession(previousId, project.id)
      // Refresh on switch — inactive durable projects have no root watcher.
      if (project.ephemeral) void get().ensureProjectTree(project)
      else void get().refreshProjectTree(project)
      return true
    } catch (e) {
      console.error('switchProject failed:', e)
      if (isDirectoryUnavailableError(e)) {
        set(s => ({
          unavailableProjectIds: withUnavailableProject(s.unavailableProjectIds, project.id, true),
        }))
      }
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
      await upsertRecentFile(proj.id, path, openedAt)
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
      const tree = await loadProjectRootTree(proj)
      set(s => ({
        fileTree: tree,
        unavailableProjectIds: withUnavailableProject(s.unavailableProjectIds, proj.id, false),
      }))
    } catch (e) {
      console.error('loadFileTree failed:', e)
      if (isDirectoryUnavailableError(e)) {
        set(s => ({
          unavailableProjectIds: withUnavailableProject(s.unavailableProjectIds, proj.id, true),
        }))
      }
      get().pushToast('error', formatReadDirErrorToast(e))
    }
  },

  expandDir: async (path: string) => {
    const proj = get().currentProject
    if (!proj) return
    const node = findNodeByPath(get().fileTree, path)
    if (node?.loaded) return
    try {
      const children = await loadDirChildren(path, proj.path, proj)
      set(s => ({
        fileTree: patchDirChildren(s.fileTree, path, children),
      }))
    } catch (e) {
      console.error('expandDir failed:', e)
      // Ephemeral dirs (Cargo deps temp, etc.) vanish between list and expand.
      if (isDirectoryUnavailableError(e)) {
        set(s => ({ fileTree: removeNodeFromTree(s.fileTree, path) }))
        return
      }
      get().pushToast('error', formatExpandDirErrorToast(e))
    }
  },

  ensureProjectTree: async (project: Project) => {
    if (get().projectTrees[project.id]) return
    try {
      const tree = await loadProjectRootTree(project)
      set(s => ({
        projectTrees: {
          ...s.projectTrees,
          [project.id]: preserveLoadedChildren(tree, s.projectTrees[project.id] ?? []),
        },
        unavailableProjectIds: withUnavailableProject(s.unavailableProjectIds, project.id, false),
      }))
    } catch (e) {
      console.error('ensureProjectTree failed:', e)
      if (isDirectoryUnavailableError(e)) {
        set(s => ({
          unavailableProjectIds: withUnavailableProject(s.unavailableProjectIds, project.id, true),
        }))
      }
      get().pushToast('error', formatReadDirErrorToast(e))
    }
  },

  refreshProjectTree: async (project: Project) => {
    const sequence = nextProjectTreeRefreshSequence(project.id)
    try {
      const tree = await loadProjectRootTree(project)
      if (!isLatestProjectTreeRefresh(project.id, sequence)) return
      // Capture this only after the root scan: any expansion that finished
      // while it was pending must be included in the recursive reload.
      const existing = get().projectTrees[project.id] ?? []
      const next = await reloadLoadedChildren(tree, existing, project.path, project)
      set(s => ({
        // An expansion can land while the scan is in flight. Keep that newer
        // lazy-loaded state instead of replacing it with this scan's snapshot.
        projectTrees: {
          ...s.projectTrees,
          ...(isLatestProjectTreeRefresh(project.id, sequence)
            ? { [project.id]: preserveLoadedChildren(next, s.projectTrees[project.id] ?? []) }
            : {}),
        },
        unavailableProjectIds: isLatestProjectTreeRefresh(project.id, sequence)
          ? withUnavailableProject(s.unavailableProjectIds, project.id, false)
          : s.unavailableProjectIds,
      }))
    } catch (e) {
      console.error('refreshProjectTree failed:', e)
      if (!isLatestProjectTreeRefresh(project.id, sequence)) return
      if (isDirectoryUnavailableError(e)) {
        set(s => ({
          unavailableProjectIds: withUnavailableProject(s.unavailableProjectIds, project.id, true),
        }))
      }
      get().pushToast('error', formatRefreshDirErrorToast(e))
    }
  },

  toggleProjectExpanded: (projectId: string) =>
    set(s => ({
      expandedProjects: {
        ...s.expandedProjects,
        [projectId]: !(s.expandedProjects[projectId] ?? true),
      },
    })),

  expandProjectDir: async (projectId: string, path: string, options?: { force?: boolean }) => {
    const project = get().projects.find(p => p.id === projectId)
    if (!project) return
    const tree = get().projectTrees[projectId] ?? []
    const node = findNodeByPath(tree, path)
    if (!options?.force && node?.loaded) return
    try {
      const children = await loadDirChildren(path, project.path, project)
      const previous = findNodeByPath(get().projectTrees[projectId] ?? [], path)
      const nextChildren =
        options?.force && previous?.children?.length
          ? await reloadLoadedChildren(children, previous.children, project.path, project)
          : children
      set(s => {
        const tree = s.projectTrees[projectId] ?? []
        return {
          projectTrees: {
            ...s.projectTrees,
            [projectId]: patchDirChildren(tree, path, nextChildren),
          },
        }
      })
    } catch (e) {
      console.error('expandProjectDir failed:', e)
      // Stale / ephemeral directories (e.g. Cargo `target/**/deps/<tmp>`) — prune quietly.
      if (isDirectoryUnavailableError(e)) {
        set(s => ({
          projectTrees: {
            ...s.projectTrees,
            [projectId]: removeNodeFromTree(s.projectTrees[projectId] ?? [], path),
          },
        }))
        return
      }
      get().pushToast('error', formatExpandDirErrorToast(e))
    }
  },

  revealFileInTree: async (filePath: string, options?: { force?: boolean }) => {
    const project = findOwningProject(get().projects, filePath)
    if (!project) return

    await get().ensureProjectTree(project)

    const tree = get().projectTrees[project.id] ?? []
    const needsWork = revealNeedsTreeLoad(tree, filePath, project)
    if (!options?.force && !needsWork) return

    set(s => ({
      treeRevealPath: filePath,
      treeRevealSeq: s.treeRevealSeq + 1,
      expandedProjects: { ...s.expandedProjects, [project.id]: true },
    }))

    for (const dir of dirsToReveal(filePath, project)) {
      await get().expandProjectDir(project.id, dir)
    }

    // Folder targets: load children so revealing a breadcrumb folder actually opens it.
    const updatedTree = get().projectTrees[project.id] ?? []
    const target = findNodeByPath(updatedTree, filePath)
    if (target) {
      if (target.path !== filePath) {
        set({ treeRevealPath: target.path })
      }
      if (target.is_dir) {
        await get().expandProjectDir(project.id, target.path)
      }
    }
  },
}))
