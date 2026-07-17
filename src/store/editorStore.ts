import { create } from 'zustand'
import { save } from '@tauri-apps/plugin-dialog'
import { safeInvoke, isTauri } from '../lib/tauri'
import { parseOpenFileError } from '../lib/openFileError'
import {
  disposeEditorSession,
  disposeEditorSessions,
  flushAllLiveEditorContents,
  flushLiveEditorContent,
  getLiveEditorContent,
} from '../lib/editorSession'
import { clearDraftForTab } from '../lib/draftRecovery'
import {
  getEditorPreferences,
  loadEffectiveEditorPreferences,
  prepareContentForSave,
} from '../lib/editorSettings'
import { isSettingsJsonPath } from '../lib/projectSettings'
import { translate } from '../lib/i18n'
import { confirmOutsideSymlinkWrite } from '../utils/symlinkWriteGuard'
import { loadEffectiveAutoSaveSettings, notifyAutoSaveSettingsChanged } from '../lib/autoSaveSettings'
import { useProjectStore } from './projectStore'
import type { EditorTab } from '../types'
import { findProjectForPath, isDescendantOf, parentPath, pathsEqual } from '../utils/fileReferences'
import { guessLanguage, isPinnedSettingsTab, tabNameFromPath } from '../utils/editorHelpers'

function resolveTabContent(tab: EditorTab): string | undefined {
  return getLiveEditorContent(tab.id) ?? tab.content
}

export interface ProjectEditorSession {
  tabs: EditorTab[]
  activeTabId: string | null
  pendingReveal: { path: string; line: number } | null
}

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string | null
  pendingReveal: { path: string; line: number } | null
  /** Inactive projects' editor sessions (tabs, active file, reveal). */
  projectSessions: Record<string, ProjectEditorSession>
  openFile: (path: string, line?: number) => Promise<void>
  retryOpenFile: (id: string) => Promise<void>
  clearPendingReveal: () => void
  closeTab: (id: string) => void
  closeOtherTabs: (id: string) => void
  closeTabsToRight: (id: string) => void
  setActiveTab: (id: string) => void
  setTabContent: (id: string, content: string) => void
  markDirty: (id: string) => void
  markClean: (id: string) => void
  saveFile: (id: string) => Promise<void>
  saveAs: (id: string) => Promise<void>
  closeAllTabs: () => void
  /** @deprecated Prefer activateProjectSession — kept for callers that only filter by path. */
  closeTabsOutsideProject: (projectPath: string) => void
  /**
   * Stash the current project's editor UI into `projectSessions` and restore
   * the target project's session. Pinned settings tabs stay visible.
   */
  activateProjectSession: (fromProjectId: string | null, toProjectId: string) => void
  /** Drop a project's stashed session and dispose CodeMirror runtime state. */
  discardProjectSession: (projectId: string) => void
  renamePath: (oldPath: string, newPath: string) => void
  closeTabsForPath: (path: string) => void
  findTab: (id: string) => EditorTab | undefined
  getAllTabs: () => EditorTab[]
  setDiskMtime: (id: string, mtime: number | null | undefined) => void
  bumpContentEpoch: (id: string) => void
  /** Replace tab buffer from disk (clears dirty, rebuilds editor session). */
  reloadFromDisk: (id: string, content: string, mtime?: number | null) => Promise<void>
}

function splitPinned(tabs: EditorTab[]) {
  const pinned: EditorTab[] = []
  const projectTabs: EditorTab[] = []
  for (const tab of tabs) {
    if (isPinnedSettingsTab(tab.path)) pinned.push(tab)
    else projectTabs.push(tab)
  }
  return { pinned, projectTabs }
}

function mapTabEverywhere(
  s: Pick<EditorState, 'tabs' | 'projectSessions'>,
  id: string,
  fn: (tab: EditorTab) => EditorTab,
): Pick<EditorState, 'tabs' | 'projectSessions'> | null {
  if (s.tabs.some(t => t.id === id)) {
    return {
      tabs: s.tabs.map(t => (t.id === id ? fn(t) : t)),
      projectSessions: s.projectSessions,
    }
  }
  for (const [projectId, session] of Object.entries(s.projectSessions)) {
    if (!session.tabs.some(t => t.id === id)) continue
    return {
      tabs: s.tabs,
      projectSessions: {
        ...s.projectSessions,
        [projectId]: {
          ...session,
          tabs: session.tabs.map(t => (t.id === id ? fn(t) : t)),
        },
      },
    }
  }
  return null
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  pendingReveal: null,
  projectSessions: {},

  clearPendingReveal: () => set({ pendingReveal: null }),

  findTab: (id: string) => {
    const s = get()
    const current = s.tabs.find(t => t.id === id)
    if (current) return current
    for (const session of Object.values(s.projectSessions)) {
      const tab = session.tabs.find(t => t.id === id)
      if (tab) return tab
    }
    return undefined
  },

  getAllTabs: () => {
    const s = get()
    const tabs = [...s.tabs]
    for (const session of Object.values(s.projectSessions)) {
      tabs.push(...session.tabs)
    }
    return tabs
  },

  openFile: async (path: string, line?: number) => {
    const existing = get().tabs.find(t => t.path === path)
    if (existing) {
      if (existing.loading) {
        set({
          activeTabId: existing.id,
          pendingReveal: line ? { path, line } : get().pendingReveal,
        })
        void useProjectStore.getState().revealFileInTree(path)
        return
      }
      const prev = get().activeTabId
      if (prev && prev !== existing.id) flushLiveEditorContent(prev)
      set({
        activeTabId: existing.id,
        pendingReveal: line && !existing.openError ? { path, line } : null,
      })
      void useProjectStore.getState().revealFileInTree(path)
      if (!existing.openError) void useProjectStore.getState().addRecentFile(path)
      return
    }

    const name = tabNameFromPath(path)
    const id = crypto.randomUUID()
    const language = guessLanguage(path)

    // Progressive open: show the tab immediately so the UI stays responsive.
    const prev = get().activeTabId
    if (prev) flushLiveEditorContent(prev)
    set(s => ({
      tabs: [
        ...s.tabs,
        { id, path, name, dirty: false, language, loading: true },
      ],
      activeTabId: id,
      pendingReveal: line ? { path, line } : null,
    }))
    void useProjectStore.getState().revealFileInTree(path)

    try {
      const content = await safeInvoke<string>('读取文件', 'read_file', { path })
      if (!get().findTab(id)) return
      let mtime: number | null = null
      try {
        mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', { path })
      } catch {
        mtime = null
      }
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          content,
          loading: false,
          openError: undefined,
          openErrorKind: undefined,
          diskMtime: mtime,
        }))
        if (!next) return s
        return {
          ...next,
          pendingReveal: line ? { path, line } : s.pendingReveal,
        }
      })
      void useProjectStore.getState().addRecentFile(path)
    } catch (e) {
      console.error('openFile failed:', e)
      if (!get().findTab(id)) return
      const { message, kind } = parseOpenFileError(e)
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          loading: false,
          content: undefined,
          openError: message,
          openErrorKind: kind,
        }))
        if (!next) return s
        return { ...next, pendingReveal: null }
      })
    }
  },

  retryOpenFile: async (id: string) => {
    const tab = get().findTab(id)
    if (!tab?.openError) return
    set(s => {
      const next = mapTabEverywhere(s, id, t => ({
        ...t,
        loading: true,
        openError: undefined,
        openErrorKind: undefined,
      }))
      return next ?? s
    })
    try {
      const content = await safeInvoke<string>('读取文件', 'read_file', { path: tab.path })
      if (!get().findTab(id)) return
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          content,
          language: guessLanguage(tab.path),
          loading: false,
          openError: undefined,
          openErrorKind: undefined,
          dirty: false,
        }))
        return next ?? s
      })
    } catch (e) {
      console.error('retryOpenFile failed:', e)
      if (!get().findTab(id)) return
      const { message, kind } = parseOpenFileError(e)
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          loading: false,
          openError: message,
          openErrorKind: kind,
        }))
        return next ?? s
      })
    }
  },

  closeTab: (id: string) => {
    flushLiveEditorContent(id)
    disposeEditorSession(id)
    set(s => {
      const tabs = s.tabs.filter(t => t.id !== id)
      if (tabs.length !== s.tabs.length) {
        const activeTabId = s.activeTabId === id
          ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
          : s.activeTabId
        return { tabs, activeTabId }
      }
      // Tab may live in a stashed project session (e.g. closed via path ops).
      let projectSessions = s.projectSessions
      for (const [projectId, session] of Object.entries(s.projectSessions)) {
        if (!session.tabs.some(t => t.id === id)) continue
        const sessionTabs = session.tabs.filter(t => t.id !== id)
        projectSessions = {
          ...s.projectSessions,
          [projectId]: {
            ...session,
            tabs: sessionTabs,
            activeTabId:
              session.activeTabId === id
                ? sessionTabs[sessionTabs.length - 1]?.id ?? null
                : session.activeTabId,
          },
        }
        break
      }
      return { projectSessions }
    })
  },

  closeOtherTabs: (id: string) => {
    flushLiveEditorContent(id)
    const closed = get().tabs.filter(t => t.id !== id).map(t => t.id)
    disposeEditorSessions(closed)
    set(s => {
      const tabs = s.tabs.filter(t => t.id === id)
      return { tabs, activeTabId: tabs.length > 0 ? id : null }
    })
  },

  closeTabsToRight: (id: string) => {
    flushLiveEditorContent(id)
    set(s => {
      const idx = s.tabs.findIndex(t => t.id === id)
      if (idx === -1) return s
      const closed = s.tabs.slice(idx + 1).map(t => t.id)
      disposeEditorSessions(closed)
      const tabs = s.tabs.slice(0, idx + 1)
      const activeTabId = tabs.some(t => t.id === s.activeTabId) ? s.activeTabId : id
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (id: string) => {
    const prev = get().activeTabId
    if (prev && prev !== id) flushLiveEditorContent(prev)
    set({ activeTabId: id })
    const tab = get().tabs.find(t => t.id === id)
    if (tab) void useProjectStore.getState().revealFileInTree(tab.path)
  },

  setTabContent: (id: string, content: string) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t => (t.openError ? t : { ...t, content }))
      return next ?? s
    })
  },

  markDirty: (id: string) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t => (t.openError ? t : { ...t, dirty: true }))
      return next ?? s
    })
  },

  markClean: (id: string) => {
    const tab = get().findTab(id)
    set(s => {
      const next = mapTabEverywhere(s, id, t => ({ ...t, dirty: false }))
      return next ?? s
    })
    if (tab) clearDraftForTab(tab.path)
  },

  setDiskMtime: (id, mtime) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t => ({ ...t, diskMtime: mtime }))
      return next ?? s
    })
  },

  bumpContentEpoch: id => {
    disposeEditorSession(id)
    set(s => {
      const next = mapTabEverywhere(s, id, t => ({
        ...t,
        contentEpoch: (t.contentEpoch ?? 0) + 1,
      }))
      return next ?? s
    })
  },

  reloadFromDisk: async (id, content, mtime) => {
    disposeEditorSession(id)
    set(s => {
      const next = mapTabEverywhere(s, id, t => ({
        ...t,
        content,
        dirty: false,
        openError: undefined,
        openErrorKind: undefined,
        loading: false,
        diskMtime: mtime ?? t.diskMtime,
        contentEpoch: (t.contentEpoch ?? 0) + 1,
      }))
      return next ?? s
    })
    const tab = get().findTab(id)
    if (tab) clearDraftForTab(tab.path)
  },

  saveFile: async (id: string) => {
    const tab = get().findTab(id)
    if (!tab || tab.openError || tab.loading) return
    const raw = resolveTabContent(tab)
    if (raw === undefined) return
    const content = prepareContentForSave(raw, getEditorPreferences())
    if (!(await confirmOutsideSymlinkWrite(tab.path))) return
    try {
      if (isTauri()) {
        try {
          await safeInvoke('抑制监视', 'suppress_fs_watch', { path: tab.path })
        } catch {
          /* best-effort */
        }
        if (tab.diskMtime != null) {
          const current = await safeInvoke<number | null>('读取修改时间', 'file_mtime', {
            path: tab.path,
          })
          if (current != null && current !== tab.diskMtime) {
            useProjectStore
              .getState()
              .pushToast(
                'error',
                translate('磁盘文件已更改，请先重新加载或比较后再保存：{name}', { name: tab.name }),
              )
            return
          }
        }
      }
      await safeInvoke('保存文件', 'write_file', { path: tab.path, content })
      let mtime: number | null = null
      try {
        mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', { path: tab.path })
      } catch {
        mtime = null
      }
      get().setTabContent(id, content)
      get().markClean(id)
      get().setDiskMtime(id, mtime)
      if (content !== raw) get().bumpContentEpoch(id)
      if (isSettingsJsonPath(tab.path)) {
        const project = useProjectStore.getState().currentProject
        void loadEffectiveEditorPreferences(project)
        void loadEffectiveAutoSaveSettings(project).then(notifyAutoSaveSettingsChanged)
      }
    } catch (e) {
      console.error('saveFile failed:', e)
      useProjectStore.getState().pushToast('error', `保存文件失败: ${String(e)}`)
    }
  },

  saveAs: async (id: string) => {
    const tab = get().findTab(id)
    if (!tab || tab.openError || tab.loading) return
    const content = resolveTabContent(tab)
    if (content === undefined) return
    if (!isTauri()) {
      useProjectStore.getState().pushToast('error', translate('当前环境无法另存为'))
      return
    }
    try {
      const selected = await save({
        title: translate('另存为'),
        defaultPath: tab.path,
      })
      if (!selected) return

      if (pathsEqual(selected, tab.path)) {
        await get().saveFile(id)
        return
      }

      if (!(await confirmOutsideSymlinkWrite(selected))) return
      await safeInvoke('另存为', 'write_file', { path: selected, content })

      const conflict = get().getAllTabs().find(t => t.id !== id && pathsEqual(t.path, selected))
      if (conflict) get().closeTab(conflict.id)

      const name = tabNameFromPath(selected)
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          path: selected,
          name,
          content,
          language: guessLanguage(selected),
          dirty: false,
        }))
        return next ?? s
      })

      const store = useProjectStore.getState()
      const project = findProjectForPath(store.projects, selected)
      if (project) {
        const parent = parentPath(selected)
        if (pathsEqual(parent, project.path)) await store.refreshProjectTree(project)
        else await store.expandProjectDir(project.id, parent)
        void store.revealFileInTree(selected)
      }
      store.pushToast('success', translate('已另存为: {name}', { name }))
    } catch (e) {
      console.error('saveAs failed:', e)
      useProjectStore.getState().pushToast(
        'error',
        translate('另存为失败: {error}', { error: String(e) }),
      )
    }
  },

  closeAllTabs: () => {
    const ids = get().tabs.map(t => t.id)
    disposeEditorSessions(ids)
    set({ tabs: [], activeTabId: null, pendingReveal: null })
  },

  closeTabsOutsideProject: (projectPath: string) =>
    set(s => {
      const closed = s.tabs
        .filter(tab => !isDescendantOf(tab.path, projectPath) && !isPinnedSettingsTab(tab.path))
        .map(tab => tab.id)
      disposeEditorSessions(closed)
      const tabs = s.tabs.filter(
        tab => isDescendantOf(tab.path, projectPath) || isPinnedSettingsTab(tab.path),
      )
      return {
        tabs,
        activeTabId: tabs.some(tab => tab.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null,
      }
    }),

  activateProjectSession: (fromProjectId, toProjectId) => {
    if (fromProjectId === toProjectId) return
    flushAllLiveEditorContents()

    set(s => {
      const { pinned, projectTabs } = splitPinned(s.tabs)
      const projectSessions = { ...s.projectSessions }

      if (fromProjectId) {
        const activeInProject =
          s.activeTabId && projectTabs.some(t => t.id === s.activeTabId)
            ? s.activeTabId
            : projectTabs[0]?.id ?? null
        projectSessions[fromProjectId] = {
          tabs: projectTabs,
          activeTabId: activeInProject,
          pendingReveal: s.pendingReveal,
        }
      }

      const incoming = projectSessions[toProjectId] ?? {
        tabs: [],
        activeTabId: null,
        pendingReveal: null,
      }
      delete projectSessions[toProjectId]

      const incomingProjectTabs = incoming.tabs.filter(t => !isPinnedSettingsTab(t.path))
      const tabs = [...incomingProjectTabs, ...pinned]

      let activeTabId = incoming.activeTabId
      if (activeTabId && !tabs.some(t => t.id === activeTabId)) activeTabId = null
      if (!activeTabId && s.activeTabId && pinned.some(t => t.id === s.activeTabId)) {
        activeTabId = s.activeTabId
      }
      if (!activeTabId) activeTabId = tabs[0]?.id ?? null

      return {
        projectSessions,
        tabs,
        activeTabId,
        pendingReveal: incoming.pendingReveal,
      }
    })
  },

  discardProjectSession: (projectId: string) => {
    const session = get().projectSessions[projectId]
    if (session) {
      disposeEditorSessions(session.tabs.map(t => t.id))
    }
    set(s => {
      if (!s.projectSessions[projectId]) return s
      const projectSessions = { ...s.projectSessions }
      delete projectSessions[projectId]
      return { projectSessions }
    })
  },

  renamePath: (oldPath: string, newPath: string) =>
    set(s => {
      const renameTab = (tab: EditorTab): EditorTab => {
        if (!isDescendantOf(tab.path, oldPath)) return tab
        const path = newPath + tab.path.slice(oldPath.length)
        return { ...tab, path, name: tabNameFromPath(path) }
      }
      const projectSessions: Record<string, ProjectEditorSession> = {}
      for (const [id, session] of Object.entries(s.projectSessions)) {
        projectSessions[id] = { ...session, tabs: session.tabs.map(renameTab) }
      }
      return {
        tabs: s.tabs.map(renameTab),
        projectSessions,
      }
    }),

  closeTabsForPath: (path: string) => {
    const s = get()
    const closedIds: string[] = []

    for (const tab of s.tabs) {
      if (isDescendantOf(tab.path, path)) closedIds.push(tab.id)
    }
    for (const session of Object.values(s.projectSessions)) {
      for (const tab of session.tabs) {
        if (isDescendantOf(tab.path, path)) closedIds.push(tab.id)
      }
    }
    disposeEditorSessions(closedIds)

    set(state => {
      const tabs = state.tabs.filter(tab => !isDescendantOf(tab.path, path))
      const projectSessions: Record<string, ProjectEditorSession> = {}
      for (const [id, session] of Object.entries(state.projectSessions)) {
        const sessionTabs = session.tabs.filter(tab => !isDescendantOf(tab.path, path))
        projectSessions[id] = {
          ...session,
          tabs: sessionTabs,
          activeTabId:
            session.activeTabId && sessionTabs.some(t => t.id === session.activeTabId)
              ? session.activeTabId
              : sessionTabs[sessionTabs.length - 1]?.id ?? null,
        }
      }
      return {
        tabs,
        projectSessions,
        activeTabId: closedIds.includes(state.activeTabId ?? '')
          ? tabs[tabs.length - 1]?.id ?? null
          : state.activeTabId,
      }
    })
  },
}))
