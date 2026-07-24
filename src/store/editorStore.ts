import { create } from 'zustand'
import { save } from '@tauri-apps/plugin-dialog'
import { safeInvoke, isTauri } from '../lib/tauri'
import { parseOpenFileError, tabNeedsDiskContent } from '../lib/openFileError'
import {
  EDIT_DEGRADED_BYTES,
  EDIT_WARN_BYTES,
  editorPerfProfile,
  fileOpenTier,
  formatFileSize,
  resolveEditMaxBytes,
} from '../lib/fileSizePolicy'
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
  type FileEncoding,
  type WritableFileEncoding,
} from '../lib/editorSettings'
import { resolveReadEncoding } from '../lib/fileEncoding'
import { loadEffectiveFileSizePreferences } from '../lib/fileSizeSettings'
import { isSettingsJsonPath } from '../lib/projectSettings'
import { translate } from '../lib/i18n'
import type { GitFileContents } from '@/lib/git/git'
import { confirmOutsideSymlinkWrite } from '../utils/symlinkWriteGuard'
import { authorizePaths } from '../lib/pathAllowlist'
import { loadEffectiveAutoSaveSettings, notifyAutoSaveSettingsChanged } from '../lib/autoSaveSettings'
import { loadEffectiveTerminalScrollback } from '@/lib/terminal/terminalScrollbackSettings'
import { loadEffectiveExcludeSettings } from '../lib/excludeSettings'
import { formatDocument } from '../lib/formatDocument'
import { useGitStatusStore } from './gitStatusStore'
import { choiceDialog } from './choiceStore'
import { useProjectStore } from './projectStore'
import { useUIStore } from './uiStore'
import { registerEditorSessionApi } from './editorSessionBridge'
import type { EditorTab } from '../types'
import {
  findProjectForPath,
  formatFileToastDetail,
  isDescendantOf,
  parentPath,
  pathsEqual,
} from '../utils/fileReferences'
import { guessLanguage, isPinnedSettingsTab, tabNameFromPath } from '../utils/editorHelpers'
import { MAX_OPEN_EDITOR_TABS, pickEvictableTabId } from '../lib/editorTabsLayout'
import {
  buildTabMru,
  fileNameFromPath,
  mapTabEverywhere,
  pendingRevealAt,
  splitPinned,
  type PendingReveal,
  type ProjectEditorSession,
} from './editorStoreHelpers'

export type { PendingReveal, ProjectEditorSession } from './editorStoreHelpers'

function resolveTabContent(tab: EditorTab): string | undefined {
  return getLiveEditorContent(tab.id) ?? tab.content
}

type FileStat = { size: number; is_dir: boolean }

/**
 * Stat → tier → edit (`read_file`) or view-only tab. Shared by open / retry / restore.
 */
async function populateTabFromDisk(id: string, path: string, line?: number, column?: number) {
  const get = () => useEditorStore.getState()
  const set = useEditorStore.setState

  const stat = await safeInvoke<FileStat>('读取文件信息', 'file_stat', { path })
  if (!get().findTab(id)) return

  if (stat.is_dir) {
    throw new Error(`无法打开文件夹：${tabNameFromPath(path)}`)
  }

  const editMaxBytes = resolveEditMaxBytes(path)
  const tier = fileOpenTier(stat.size, editMaxBytes)
  if (tier === 'reject') {
    throw new Error(
      `暂不支持打开超过 500MB 的大文件：${tabNameFromPath(path)}`,
    )
  }

  let mtime: number | null = null
  try {
    mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', { path })
  } catch {
    mtime = null
  }
  if (!get().findTab(id)) return

  if (tier === 'view') {
    set(s => {
      const next = mapTabEverywhere(s, id, t => ({
        ...t,
        content: undefined,
        viewMode: 'view' as const,
        fileSize: stat.size,
        loading: false,
        dirty: false,
        openError: undefined,
        openErrorKind: undefined,
        diskMtime: mtime,
        language: guessLanguage(path),
      }))
      if (!next) return s
      return { ...next, pendingReveal: null }
    })
    useProjectStore.getState().pushToast(
      'info',
      translate('已以只读预览打开大文件（{size}，不可编辑）', {
        size: formatFileSize(stat.size),
      }),
    )
    return
  }

  const encoding = await resolveReadEncoding(path, getEditorPreferences().encoding)
  const content = await safeInvoke<string>('读取文件', 'read_file', { path, encoding })
  if (!get().findTab(id)) return

  set(s => {
    const next = mapTabEverywhere(s, id, t => ({
      ...t,
      content,
      viewMode: 'edit' as const,
      fileSize: stat.size,
      encoding,
      loading: false,
      openError: undefined,
      openErrorKind: undefined,
      diskMtime: mtime,
      language: guessLanguage(path),
      dirty: false,
    }))
    if (!next) return s
    return {
      ...next,
      pendingReveal: pendingRevealAt(path, line, column) ?? s.pendingReveal,
    }
  })

  const profile = editorPerfProfile(stat.size, editMaxBytes)
  if (profile === 'plain') {
    useProjectStore.getState().pushToast(
      'info',
      translate('文件较大（{size}），已以纯文本模式打开（限撤销、无高亮）', {
        size: formatFileSize(stat.size),
      }),
    )
  } else if (profile === 'degraded' || stat.size >= EDIT_DEGRADED_BYTES) {
    useProjectStore.getState().pushToast(
      'info',
      translate('文件较大（{size}），已关闭高亮/换行/折叠等以保持流畅', {
        size: formatFileSize(stat.size),
      }),
    )
  } else if (stat.size >= EDIT_WARN_BYTES) {
    useProjectStore.getState().pushToast(
      'info',
      translate('文件较大（{size}），已关闭语法高亮以保持流畅', {
        size: formatFileSize(stat.size),
      }),
    )
  }
}

interface EditorState {
  tabs: EditorTab[]
  activeTabId: string | null
  pendingReveal: PendingReveal | null
  /** Inactive projects' editor sessions (tabs, active file, reveal). */
  projectSessions: Record<string, ProjectEditorSession>
  /** Caret position of the active editor, shown in the status bar. */
  cursor: { line: number; col: number } | null
  /** Most-recently-used tab order for Ctrl+Tab cycling. */
  tabMru: string[]
  openFile: (path: string, line?: number, column?: number) => Promise<void>
  retryOpenFile: (id: string) => Promise<void>
  /** Open a read-only HEAD ↔ working-tree compare tab for a project-relative file. */
  openDiff: (projectPath: string, relativePath: string, absolutePath: string) => Promise<void>
  clearPendingReveal: () => void
  setCursor: (cursor: { line: number; col: number } | null) => void
  closeTab: (id: string) => void
  closeOtherTabs: (id: string) => void
  closeTabsToRight: (id: string) => void
  setActiveTab: (id: string) => void
  cycleTabMru: () => void
  reorderTabs: (fromIndex: number, toIndex: number) => void
  setTabContent: (id: string, content: string) => void
  /** Drop Zustand content copy while the live CodeMirror buffer owns the doc. */
  clearTabContentBuffer: (id: string) => void
  markDirty: (id: string) => void
  markClean: (id: string) => void
  /** Choose the encoding used when the current buffer is next saved (conversion). */
  setTabEncoding: (id: string, encoding: WritableFileEncoding) => void
  /** Discard the current buffer after confirmation and read the disk file with a chosen encoding. */
  reopenWithEncoding: (id: string, encoding: FileEncoding) => Promise<void>
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
  /**
   * Stash the active project's visible tabs into `projectSessions` and leave
   * only pinned settings tabs visible. Call before clearing `currentProject`
   * so close/hide of the last project still persists the session.
   */
  deactivateProjectSession: (projectId: string) => void
  /** Drop a project's stashed session and dispose CodeMirror runtime state. */
  discardProjectSession: (projectId: string) => void
  /**
   * Merge stashed sessions for inactive projects (named workspace restore).
   * Does not change the currently visible `tabs` array.
   */
  mergeProjectSessions: (sessions: Record<string, ProjectEditorSession>) => void
  /**
   * Replace the visible project's tabs (keeps pinned settings tabs).
   * Used when activating a named workspace that is already the current project.
   */
  applyVisibleProjectSession: (session: ProjectEditorSession) => void
  renamePath: (oldPath: string, newPath: string) => void
  closeTabsForPath: (path: string) => void
  /** Close HEAD↔working-tree compare tabs for a path (keeps regular editor tabs). */
  closeDiffTabsForPath: (path: string) => void
  findTab: (id: string) => EditorTab | undefined
  getAllTabs: () => EditorTab[]
  setDiskMtime: (id: string, mtime: number | null | undefined) => void
  bumpContentEpoch: (id: string) => void
  /** Replace tab buffer from disk (clears dirty, rebuilds editor session). */
  reloadFromDisk: (id: string, content: string, mtime?: number | null) => Promise<void>
  /**
   * After session restore: load disk content for tabs that only have a path
   * (draft bodies may already be attached). Safe to call repeatedly.
   */
  loadMissingTabContents: () => Promise<void>
}

/** Close least-recent clean tabs until there is room for one more open. */
function ensureOpenTabCapacity(): boolean {
  const get = () => useEditorStore.getState()
  while (get().tabs.length >= MAX_OPEN_EDITOR_TABS) {
    const { tabs, tabMru, activeTabId } = get()
    const victim = pickEvictableTabId(tabs, tabMru, isPinnedSettingsTab, activeTabId)
    if (!victim) {
      useProjectStore.getState().pushToast(
        'warn',
        translate('已达到最多同时打开 {max} 个标签，请先关闭部分文件', {
          max: MAX_OPEN_EDITOR_TABS,
        }),
      )
      return false
    }
    get().closeTab(victim)
  }
  return true
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  pendingReveal: null,
  projectSessions: {},
  cursor: null,
  tabMru: [],

  clearPendingReveal: () => set({ pendingReveal: null }),

  setCursor: cursor => set({ cursor }),

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

  openFile: async (path: string, line?: number, column?: number) => {
    useUIStore.getState().expandSideEditor()
    const reveal = pendingRevealAt(path, line, column)
    const existing = get().tabs.find(t => t.kind !== 'diff' && t.path === path)
    if (existing) {
      if (existing.loading) {
        set({
          activeTabId: existing.id,
          pendingReveal: reveal ?? get().pendingReveal,
        })
        void useProjectStore.getState().revealFileInTree(path)
        return
      }
      const prev = get().activeTabId
      if (prev && prev !== existing.id) flushLiveEditorContent(prev)
      // Session-restored / never-hydrated tabs: activate and load — do not leave an empty editor.
      if (tabNeedsDiskContent(existing) && existing.content === undefined) {
        set({
          activeTabId: existing.id,
          pendingReveal: reveal && !existing.openError ? reveal : null,
        })
        void useProjectStore.getState().revealFileInTree(path)
        set(s => {
          const next = mapTabEverywhere(s, existing.id, t =>
            t.openError ? t : { ...t, loading: true, openError: undefined, openErrorKind: undefined },
          )
          return next ?? s
        })
        try {
          await populateTabFromDisk(existing.id, path, line, column)
          void useProjectStore.getState().addRecentFile(path)
        } catch (e) {
          console.error('openFile failed:', e)
          if (!get().findTab(existing.id)) return
          const { message, kind } = parseOpenFileError(e)
          set(s => {
            const next = mapTabEverywhere(s, existing.id, t => ({
              ...t,
              loading: false,
              content: undefined,
              viewMode: 'edit',
              openError: message,
              openErrorKind: kind,
            }))
            if (!next) return s
            return { ...next, pendingReveal: null }
          })
        }
        return
      }
      set({
        activeTabId: existing.id,
        pendingReveal: reveal && !existing.openError ? reveal : null,
      })
      void useProjectStore.getState().revealFileInTree(path)
      if (!existing.openError) void useProjectStore.getState().addRecentFile(path)
      return
    }

    if (!ensureOpenTabCapacity()) return

    const name = tabNameFromPath(path)
    const id = crypto.randomUUID()
    const language = guessLanguage(path)

    // Progressive open: show the tab immediately so the UI stays responsive.
    const prev = get().activeTabId
    if (prev) flushLiveEditorContent(prev)
    set(s => {
      const tabs = [
        ...s.tabs,
        { id, path, name, dirty: false, language, loading: true },
      ]
      return {
        tabs,
        activeTabId: id,
        pendingReveal: reveal,
        tabMru: buildTabMru(tabs, id),
      }
    })
    void useProjectStore.getState().revealFileInTree(path)

    try {
      await populateTabFromDisk(id, path, line, column)
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
          viewMode: 'edit',
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
      await populateTabFromDisk(id, tab.path)
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
        return { tabs, activeTabId, tabMru: buildTabMru(tabs, activeTabId) }
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
    set(s => ({
      activeTabId: id,
      cursor: null,
      tabMru: buildTabMru(s.tabs, id),
    }))
    const tab = get().tabs.find(t => t.id === id)
    if (tab && tab.kind !== 'diff') void useProjectStore.getState().revealFileInTree(tab.path)
  },

  cycleTabMru: () => {
    const { tabs, activeTabId, tabMru } = get()
    const ordered = tabMru.filter(id => tabs.some(tab => tab.id === id))
    if (ordered.length < 2) return
    const currentIndex = ordered.indexOf(activeTabId ?? '')
    const nextIndex = currentIndex < 0 ? 1 : (currentIndex + 1) % ordered.length
    get().setActiveTab(ordered[nextIndex])
  },

  reorderTabs: (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    set(s => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= s.tabs.length || toIndex >= s.tabs.length) {
        return s
      }
      const tabs = [...s.tabs]
      const [moved] = tabs.splice(fromIndex, 1)
      tabs.splice(toIndex, 0, moved)
      return { tabs, tabMru: buildTabMru(tabs, s.activeTabId) }
    })
  },

  openDiff: async (projectPath: string, relativePath: string, absolutePath: string) => {
    useUIStore.getState().expandSideEditor()
    const existing = get().tabs.find(t => t.kind === 'diff' && t.path === absolutePath)
    if (existing) {
      const prev = get().activeTabId
      if (prev && prev !== existing.id) flushLiveEditorContent(prev)
      set({ activeTabId: existing.id, cursor: null, pendingReveal: null })
      return
    }
    if (!ensureOpenTabCapacity()) return
    try {
      try {
        const stat = await safeInvoke<FileStat>('读取文件信息', 'file_stat', { path: absolutePath })
        if (stat.is_dir) {
          useProjectStore.getState().pushToast(
            'info',
            translate('无法在文本编辑器中打开文件夹。'),
          )
          return
        }
      } catch {
        // Deleted / missing paths can still show a HEAD-side diff.
      }
      const pair = await safeInvoke<GitFileContents>('读取 Git 文件内容', 'git_file_contents', {
        path: projectPath,
        file: absolutePath,
      })
      const name = fileNameFromPath(relativePath)
      const id = crypto.randomUUID()
      const prev = get().activeTabId
      if (prev) flushLiveEditorContent(prev)
      const tab: EditorTab = {
        id,
        path: absolutePath,
        name: `${name} (对比)`,
        dirty: false,
        kind: 'diff',
        content: pair.modified,
        originalContent: pair.original,
        language: guessLanguage(relativePath),
        encoding: 'utf8',
      }
      set(s => ({
        tabs: [...s.tabs, tab],
        activeTabId: id,
        cursor: null,
        pendingReveal: null,
        tabMru: buildTabMru([...s.tabs, tab], id),
      }))
    } catch (e) {
      console.error('openDiff failed:', e)
      useProjectStore.getState().pushToast(
        'error',
        translate('打开差异对比失败：{error}', { error: String(e) }),
      )
    }
  },

  setTabContent: (id: string, content: string) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t => (t.openError ? t : { ...t, content }))
      return next ?? s
    })
  },

  clearTabContentBuffer: (id: string) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t =>
        t.openError || t.content === undefined ? t : { ...t, content: undefined },
      )
      return next ?? s
    })
  },

  markDirty: (id: string) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t =>
        t.openError || t.kind === 'diff' ? t : { ...t, dirty: true },
      )
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

  setTabEncoding: (id, encoding) => {
    set(s => {
      const next = mapTabEverywhere(s, id, t =>
        t.kind === 'diff' || t.encoding === encoding ? t : { ...t, encoding, dirty: true },
      )
      return next ?? s
    })
  },

  reopenWithEncoding: async (id, requestedEncoding) => {
    const tab = get().findTab(id)
    if (!tab || tab.kind === 'diff' || tab.openError || tab.loading || tab.viewMode === 'view') return
    if (!isTauri()) {
      useProjectStore.getState().pushToast('error', translate('当前环境无法重新打开文件'))
      return
    }
    if (tab.dirty) {
      const choice = await choiceDialog({
        title: translate('重新按编码打开文件？'),
        message: translate('这会放弃当前文件的未保存修改，并按 {encoding} 重新读取磁盘内容。', {
          encoding: requestedEncoding === 'auto' ? translate('自动检测') : requestedEncoding.toUpperCase(),
        }),
        detail: tab.path,
        options: [
          { id: 'reload', label: translate('重新打开'), primary: true },
          { id: 'cancel', label: translate('取消') },
        ],
      })
      if (choice !== 'reload') return
    }
    try {
      const encoding = await resolveReadEncoding(tab.path, requestedEncoding)
      const [content, mtime] = await Promise.all([
        safeInvoke<string>('读取文件', 'read_file', { path: tab.path, encoding }),
        safeInvoke<number | null>('读取修改时间', 'file_mtime', { path: tab.path }).catch(() => null),
      ])
      await get().reloadFromDisk(id, content, mtime)
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({ ...t, encoding }))
        return next ?? s
      })
      useProjectStore
        .getState()
        .pushToast('success', translate('已按 {encoding} 重新打开：{name}', { encoding: encoding.toUpperCase(), name: tab.name }))
    } catch (e) {
      useProjectStore
        .getState()
        .pushToast('error', translate('重新打开文件失败: {error}', { error: String(e) }))
    }
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

  loadMissingTabContents: async () => {
    const targets = get()
      .tabs.filter(t => t.kind !== 'diff' && tabNeedsDiskContent(t))
      .map(t => t.id)
    if (targets.length === 0) return

    set(s => ({
      tabs: s.tabs.map(t =>
        targets.includes(t.id) && t.content === undefined ? { ...t, loading: true } : t,
      ),
    }))

    await Promise.all(
      targets.map(async id => {
        const initial = get().findTab(id)
        if (!initial) return
        try {
          // Draft-restored buffers already have content; only refresh mtime.
          if (initial.content !== undefined && initial.viewMode !== 'view') {
            let mtime: number | null = null
            try {
              mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', {
                path: initial.path,
              })
            } catch {
              mtime = null
            }
            if (!get().findTab(id)) return
            set(s => {
              const next = mapTabEverywhere(s, id, t => ({
                ...t,
                loading: false,
                diskMtime: mtime,
              }))
              return next ?? s
            })
            return
          }

          await populateTabFromDisk(id, initial.path)
        } catch (e) {
          console.error('loadMissingTabContents failed:', e)
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
      }),
    )
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
    if (!tab || tab.kind === 'diff' || tab.openError || tab.loading || tab.viewMode === 'view') return
    // Format-on-save before reading the buffer for write (quiet: no success spam).
    try {
      const { getFormatOnSave } = await import('../lib/formatOnSaveSettings')
      if (getFormatOnSave()) {
        await formatDocument(id, { quiet: true })
      }
    } catch (e) {
      console.error('formatOnSave failed:', e)
    }
    const afterFormat = get().findTab(id)
    if (
      !afterFormat ||
      afterFormat.kind === 'diff' ||
      afterFormat.openError ||
      afterFormat.loading ||
      afterFormat.viewMode === 'view'
    ) {
      return
    }
    const raw = resolveTabContent(afterFormat)
    if (raw === undefined) return
    const content = prepareContentForSave(raw, getEditorPreferences())
    if (!(await confirmOutsideSymlinkWrite(afterFormat.path))) return
    try {
      if (isTauri()) {
        try {
          await safeInvoke('抑制监视', 'suppress_fs_watch', { path: afterFormat.path })
        } catch {
          /* best-effort */
        }
        if (afterFormat.diskMtime != null) {
          const current = await safeInvoke<number | null>('读取修改时间', 'file_mtime', {
            path: afterFormat.path,
          })
          if (current != null && current !== afterFormat.diskMtime) {
            const { projects, pushToast } = useProjectStore.getState()
            pushToast(
              'error',
              translate('磁盘文件已更改，请先重新加载或比较后再保存'),
              formatFileToastDetail(projects, afterFormat.path, afterFormat.name),
            )
            return
          }
        }
      }
      const encoding = afterFormat.encoding ?? await resolveReadEncoding(
        afterFormat.path,
        getEditorPreferences().encoding,
      )
      await safeInvoke('保存文件', 'write_file', {
        path: afterFormat.path,
        content,
        encoding,
      })
      let mtime: number | null = null
      try {
        mtime = await safeInvoke<number | null>('读取修改时间', 'file_mtime', { path: tab.path })
      } catch {
        mtime = null
      }
      get().setTabContent(id, content)
      get().markClean(id)
      get().setDiskMtime(id, mtime)
      useGitStatusStore.getState().scheduleRefresh(undefined, 200)
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          fileSize: new TextEncoder().encode(content).length,
        }))
        return next ?? s
      })
      if (content !== raw) get().bumpContentEpoch(id)
      // Active plain tabs: keep a single buffer in CodeMirror.
      {
        const saved = get().findTab(id)
        const editMax = saved ? resolveEditMaxBytes(saved.path) : undefined
        if (
          editorPerfProfile(saved?.fileSize ?? content.length, editMax) === 'plain' &&
          getLiveEditorContent(id) !== null
        ) {
          get().clearTabContentBuffer(id)
        }
      }
      if (isSettingsJsonPath(tab.path)) {
        const project = useProjectStore.getState().currentProject
        void loadEffectiveEditorPreferences(project)
        void loadEffectiveFileSizePreferences(project)
        void loadEffectiveAutoSaveSettings(project).then(notifyAutoSaveSettingsChanged)
        void import('../lib/formatOnSaveSettings').then(({ loadEffectiveFormatOnSave }) =>
          loadEffectiveFormatOnSave(project),
        )
        void import('../lib/minimapSettings').then(({ loadEffectiveMinimapEnabled }) =>
          loadEffectiveMinimapEnabled(project),
        )
        void loadEffectiveTerminalScrollback(project)
        void import('@/lib/terminal/terminalCursorSettings').then(
          ({ loadEffectiveTerminalCursorBlinking }) =>
            loadEffectiveTerminalCursorBlinking(project),
        )
        void loadEffectiveExcludeSettings(project).then(() => {
          const store = useProjectStore.getState()
          for (const p of store.projects) {
            if (!p.ephemeral && store.projectTrees[p.id]) {
              void store.refreshProjectTree(p)
            }
          }
          if (project && store.fileTree.length > 0) {
            void store.loadFileTree()
          }
        })
      }
    } catch (e) {
      console.error('saveFile failed:', e)
      useProjectStore.getState().pushToast('error', `保存文件失败: ${String(e)}`)
    }
  },

  saveAs: async (id: string) => {
    const tab = get().findTab(id)
    if (!tab || tab.kind === 'diff' || tab.openError || tab.loading) return
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
      // Explicit Save As dialog = user authorization for that write target.
      await authorizePaths([selected])
      const encoding = tab.encoding ?? await resolveReadEncoding(tab.path, getEditorPreferences().encoding)
      await safeInvoke('另存为', 'write_file', { path: selected, content, encoding })

      const conflict = get().getAllTabs().find(t => t.id !== id && pathsEqual(t.path, selected))
      if (conflict) get().closeTab(conflict.id)

      const name = tabNameFromPath(selected)
      set(s => {
        const next = mapTabEverywhere(s, id, t => ({
          ...t,
          path: selected,
          name,
          content,
          encoding,
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
        tabMru: buildTabMru(tabs, activeTabId),
      }
    })
  },

  deactivateProjectSession: projectId => {
    flushAllLiveEditorContents()

    set(s => {
      const { pinned, projectTabs } = splitPinned(s.tabs)
      const projectSessions = { ...s.projectSessions }
      const activeInProject =
        s.activeTabId && projectTabs.some(t => t.id === s.activeTabId)
          ? s.activeTabId
          : projectTabs[0]?.id ?? null
      projectSessions[projectId] = {
        tabs: projectTabs,
        activeTabId: activeInProject,
        pendingReveal: s.pendingReveal,
      }

      let activeTabId =
        s.activeTabId && pinned.some(t => t.id === s.activeTabId) ? s.activeTabId : null
      if (!activeTabId) activeTabId = pinned[0]?.id ?? null

      return {
        projectSessions,
        tabs: pinned,
        activeTabId,
        pendingReveal: null,
        tabMru: buildTabMru(pinned, activeTabId),
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

  mergeProjectSessions: sessions => {
    const entries = Object.entries(sessions)
    if (entries.length === 0) return
    set(s => {
      const projectSessions = { ...s.projectSessions }
      for (const [projectId, session] of entries) {
        const previous = projectSessions[projectId]
        if (previous) {
          disposeEditorSessions(previous.tabs.map(t => t.id))
        }
        projectSessions[projectId] = {
          tabs: session.tabs,
          activeTabId: session.activeTabId,
          pendingReveal: session.pendingReveal ?? null,
        }
      }
      return { projectSessions }
    })
  },

  applyVisibleProjectSession: session => {
    flushAllLiveEditorContents()
    set(s => {
      const { pinned, projectTabs } = splitPinned(s.tabs)
      disposeEditorSessions(projectTabs.map(t => t.id))
      const incoming = session.tabs.filter(t => !isPinnedSettingsTab(t.path))
      const tabs = [...incoming, ...pinned]
      let activeTabId = session.activeTabId
      if (activeTabId && !tabs.some(t => t.id === activeTabId)) activeTabId = null
      if (!activeTabId && s.activeTabId && pinned.some(t => t.id === s.activeTabId)) {
        activeTabId = s.activeTabId
      }
      if (!activeTabId) activeTabId = tabs[0]?.id ?? null
      return {
        tabs,
        activeTabId,
        pendingReveal: session.pendingReveal ?? null,
      }
    })
  },

  renamePath: (oldPath: string, newPath: string) =>
    set(s => {
      const renameTab = (tab: EditorTab): EditorTab => {
        if (!isDescendantOf(tab.path, oldPath)) return tab
        const path = newPath + tab.path.slice(oldPath.length)
        const baseName = tabNameFromPath(path)
        const name = tab.kind === 'diff' ? `${baseName} (对比)` : baseName
        return { ...tab, path, name }
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

  closeDiffTabsForPath: (path: string) => {
    const s = get()
    const closedIds: string[] = []

    const isDiffForPath = (tab: EditorTab) =>
      tab.kind === 'diff' && isDescendantOf(tab.path, path)

    for (const tab of s.tabs) {
      if (isDiffForPath(tab)) closedIds.push(tab.id)
    }
    for (const session of Object.values(s.projectSessions)) {
      for (const tab of session.tabs) {
        if (isDiffForPath(tab)) closedIds.push(tab.id)
      }
    }
    if (closedIds.length === 0) return
    disposeEditorSessions(closedIds)

    set(state => {
      const tabs = state.tabs.filter(tab => !closedIds.includes(tab.id))
      const projectSessions: Record<string, ProjectEditorSession> = {}
      for (const [id, session] of Object.entries(state.projectSessions)) {
        const sessionTabs = session.tabs.filter(tab => !closedIds.includes(tab.id))
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

registerEditorSessionApi({
  activateProjectSession: (previousId, nextId) =>
    useEditorStore.getState().activateProjectSession(previousId, nextId),
  deactivateProjectSession: projectId =>
    useEditorStore.getState().deactivateProjectSession(projectId),
  renamePath: (from, to) => useEditorStore.getState().renamePath(from, to),
})
