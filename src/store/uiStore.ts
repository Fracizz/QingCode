import { create } from 'zustand'
import { loadActivityBarHidden, saveActivityBarHidden } from '../lib/activityBarLayout'
import {
  nextPanelLayoutMode,
  normalizePanelLayoutMode,
  panelLayoutModeParts,
  resolvePanelLayoutMode,
  type PanelLayoutPreset,
} from '../lib/panelLayoutMode'
import {
  loadPanelLayoutTemplate,
  savePanelLayoutTemplate,
  type PanelLayoutTemplate,
} from '../lib/panelLayoutTemplate'
import {
  loadSideWorkspaceColumns,
  normalizeSideWorkspaceColumns,
  saveSideWorkspaceColumns,
  type SideWorkspaceColumns,
} from '../lib/sideWorkspaceLayout'
import { isExternalFileWindow } from '../lib/windowSession'

export type View = 'explorer' | 'search' | 'sourceControl' | 'run' | 'settings'

interface UIState {
  view: View
  /** Whether the left sidebar panel is visible (VS Code-style toggle). */
  sidebarOpen: boolean
  /** Whether the activity bar is tucked away to the left edge. */
  activityBarHidden: boolean
  /** When set, search is restricted to this directory path (absolute). */
  searchRoot: string | null
  /** Incremented when the search shortcut opens the search view. */
  globalSearchSignal: number
  /** Optional editor selection used to seed the latest global-search request. */
  globalSearchQuery: string | null
  /** Incremented to request the terminal panel to open (e.g. when a run config starts). */
  terminalOpenSignal: number
  /** Incremented to toggle the terminal panel (shortcut / command palette). */
  terminalToggleSignal: number
  /** When true, explorer should start inline “new file” at the project root. */
  pendingNewFile: boolean
  /** Terminal dock template shared by the title bar, commands, and app layout. */
  panelLayout: PanelLayoutTemplate
  /** True while switching classic ↔ side terminal; suppresses dock transitions. */
  panelLayoutSwitching: boolean
  /** Side dock: show a second terminal column. */
  sideDualTerminal: boolean
  /** Side dock: 2×2 田 terminal grid (mutually exclusive with dual). */
  sideQuadTerminal: boolean
  /** Side dock: show the editor column (independent from dual/quad). */
  sideEditorVisible: boolean
  /** Search query for the latest Settings deep-link (e.g. files.autoSave). */
  settingsFocusQuery: string | null
  /** Incremented when opening Settings with a focus query. */
  settingsFocusSignal: number
  /** Whether the project manager modal is open. */
  projectManagerOpen: boolean
  /** Whether the named multi-project workspace manager modal is open. */
  workspaceManagerOpen: boolean
  /** Whether the SSH remote connections manager modal is open. */
  remoteConnectionsOpen: boolean
  /** 进入整页视图（源代码管理/设置）前的布局快照，离开时恢复；null 表示不在整页视图。 */
  fullPageRestore: FullPageRestore | null
  setView: (view: View) => void
  /** 切换项目时回到资源管理器视图，但保留侧栏的展开/收起状态。 */
  showExplorerViewKeepingSidebar: () => void
  /** Activity bar click: switch view, or collapse when clicking the active view again. */
  toggleActivityView: (view: View) => void
  setActivityBarHidden: (hidden: boolean) => void
  toggleActivityBar: () => void
  setSearchRoot: (path: string | null) => void
  /** Switch to the search view, optionally scoped to a directory and seeded with a query. */
  requestSearch: (root?: string | null, query?: string) => void
  /** Switch to the search view and focus the query input (defaults to current project). */
  requestGlobalSearch: (query?: string) => void
  /** Open explorer and request creating a new file at the current project root. */
  requestNewFile: () => void
  /** Clear a pending new-file request after the explorer handles it. */
  clearPendingNewFile: () => void
  /** Open Settings (user scope) and optionally prefill the search box. */
  requestSettings: (query?: string) => void
  /** Request the terminal panel to open. */
  openTerminalPanel: () => void
  /** Toggle the terminal panel open/closed. */
  requestToggleTerminal: () => void
  /** Apply a title-bar / command layout preset. */
  setPanelLayoutMode: (mode: PanelLayoutPreset) => void
  /** Cycle classic → side → dual+editor. */
  togglePanelLayout: () => void
  setSideWorkspaceColumns: (columns: Partial<SideWorkspaceColumns>) => void
  toggleSideDualTerminal: () => void
  toggleSideQuadTerminal: () => void
  toggleSideEditorVisible: () => void
  /** Ensure the editor column is visible (open file / SCM / Settings); keeps dual/quad. */
  expandSideEditor: () => void
  openProjectManager: () => void
  closeProjectManager: () => void
  openWorkspaceManager: () => void
  closeWorkspaceManager: () => void
  openRemoteConnections: () => void
  closeRemoteConnections: () => void
}

interface FullPageRestore {
  sidebarOpen: boolean
  /** 进入前侧边终端布局的编辑器列是否可见；整页期间用户手动调整列后置为 null，不再恢复。 */
  editorVisible: boolean | null
}

function isFullPageView(view: View) {
  return view === 'sourceControl' || view === 'settings'
}

/** 进入整页视图：临时显示编辑器列（不持久化），并记录进入前的布局以便离开时恢复。 */
function enterFullPage(state: UIState, view: View) {
  const fullPageRestore = state.fullPageRestore ?? {
    sidebarOpen: state.sidebarOpen,
    editorVisible: state.sideEditorVisible,
  }
  return {
    view,
    sidebarOpen: true,
    sideEditorVisible: true,
    fullPageRestore,
  }
}

/** 离开整页视图：恢复进入前的编辑器列可见性。 */
function leaveFullPage(state: UIState) {
  const restore = state.fullPageRestore
  if (!restore) return {}
  return {
    fullPageRestore: null,
    ...(restore.editorVisible === null ? {} : { sideEditorVisible: restore.editorVisible }),
  }
}

/** 整页期间手动调整编辑器列后，离开时不再覆盖用户的新选择。 */
function keepEditorAfterFullPage(state: UIState) {
  return state.fullPageRestore
    ? { fullPageRestore: { ...state.fullPageRestore, editorVisible: null } }
    : {}
}

/** 需持久化的编辑器列可见性：整页期间临时显示的编辑器列不写入存储。 */
function persistedEditorVisible(state: UIState) {
  return state.fullPageRestore?.editorVisible ?? state.sideEditorVisible
}

function persistColumns(columns: SideWorkspaceColumns) {
  saveSideWorkspaceColumns(columns)
}

function columnsFromState(state: {
  sideDualTerminal: boolean
  sideQuadTerminal: boolean
  sideEditorVisible: boolean
}): SideWorkspaceColumns {
  return normalizeSideWorkspaceColumns({
    dualTerminal: state.sideDualTerminal,
    quadTerminal: state.sideQuadTerminal,
    editorVisible: state.sideEditorVisible,
  })
}

function applyColumns(columns: SideWorkspaceColumns) {
  return {
    sideDualTerminal: columns.dualTerminal,
    sideQuadTerminal: columns.quadTerminal,
    sideEditorVisible: columns.editorVisible,
  }
}

const initialColumns = loadSideWorkspaceColumns()

export const useUIStore = create<UIState>((set) => ({
  view: 'explorer',
  sidebarOpen: !isExternalFileWindow(),
  activityBarHidden: loadActivityBarHidden(),
  searchRoot: null,
  globalSearchSignal: 0,
  globalSearchQuery: null,
  terminalOpenSignal: 0,
  terminalToggleSignal: 0,
  pendingNewFile: false,
  panelLayout: loadPanelLayoutTemplate(),
  panelLayoutSwitching: false,
  sideDualTerminal: initialColumns.dualTerminal,
  sideQuadTerminal: initialColumns.quadTerminal,
  sideEditorVisible: initialColumns.editorVisible,
  settingsFocusQuery: null,
  settingsFocusSignal: 0,
  projectManagerOpen: false,
  workspaceManagerOpen: false,
  remoteConnectionsOpen: false,
  fullPageRestore: null,
  setView: view =>
    set(state => {
      if (isFullPageView(view)) return enterFullPage(state, view)
      return { view, sidebarOpen: true, ...leaveFullPage(state) }
    }),
  showExplorerViewKeepingSidebar: () =>
    set(state => {
      const restore = state.fullPageRestore
      return {
        view: 'explorer',
        ...leaveFullPage(state),
        ...(restore ? { sidebarOpen: restore.sidebarOpen } : {}),
      }
    }),
  toggleActivityView: view =>
    set(state => {
      if (isFullPageView(view)) {
        if (state.view !== view) return enterFullPage(state, view)
        // 再次点击整页视图图标：回到资源管理器，并恢复进入前的侧栏与编辑器列状态。
        const restore = state.fullPageRestore
        return {
          view: 'explorer',
          ...leaveFullPage(state),
          sidebarOpen: restore ? restore.sidebarOpen : true,
        }
      }
      const leave = leaveFullPage(state)
      if (state.view === view && state.sidebarOpen) return { sidebarOpen: false, ...leave }
      return { view, sidebarOpen: true, ...leave }
    }),
  setActivityBarHidden: hidden => {
    saveActivityBarHidden(hidden)
    set({ activityBarHidden: hidden })
  },
  toggleActivityBar: () =>
    set(state => {
      const activityBarHidden = !state.activityBarHidden
      saveActivityBarHidden(activityBarHidden)
      return { activityBarHidden }
    }),
  setSearchRoot: path => set({ searchRoot: path }),
  requestSearch: (root, query) => set(state => ({
    ...leaveFullPage(state),
    view: 'search',
    searchRoot: root ?? null,
    sidebarOpen: true,
    globalSearchQuery: query?.trim() || null,
    globalSearchSignal: state.globalSearchSignal + 1,
  })),
  requestGlobalSearch: query => set(state => ({
    ...leaveFullPage(state),
    view: 'search',
    searchRoot: null,
    sidebarOpen: true,
    globalSearchQuery: query?.trim() || null,
    globalSearchSignal: state.globalSearchSignal + 1,
  })),
  requestNewFile: () =>
    set(state => ({
      ...leaveFullPage(state),
      view: 'explorer',
      sidebarOpen: true,
      pendingNewFile: true,
    })),
  clearPendingNewFile: () => set({ pendingNewFile: false }),
  requestSettings: query =>
    set(state => {
      return {
        ...enterFullPage(state, 'settings'),
        settingsFocusQuery: query ?? null,
        settingsFocusSignal: state.settingsFocusSignal + 1,
      }
    }),
  openTerminalPanel: () => set(s => ({ terminalOpenSignal: s.terminalOpenSignal + 1 })),
  requestToggleTerminal: () => set(s => ({ terminalToggleSignal: s.terminalToggleSignal + 1 })),
  setPanelLayoutMode: mode =>
    set(state => {
      const normalized = normalizePanelLayoutMode(mode)
      const current = resolvePanelLayoutMode(state.panelLayout, columnsFromState(state))
      if (current === normalized) return state

      const { panelLayout, columns } = panelLayoutModeParts(normalized)
      const dockChanged = state.panelLayout !== panelLayout
      savePanelLayoutTemplate(panelLayout)
      if (columns) persistColumns(columns)

      return {
        panelLayout,
        ...(columns ? { ...applyColumns(columns), ...keepEditorAfterFullPage(state) } : {}),
        panelLayoutSwitching: dockChanged,
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  togglePanelLayout: () => {
    const state = useUIStore.getState()
    const current = resolvePanelLayoutMode(state.panelLayout, columnsFromState(state))
    // Fine-tuned (editor hidden / 田): cycle from the nearest side preset so the next
    // step is predictable (dual → classic, single → dual+editor).
    const cycleFrom =
      current ??
      (state.sideDualTerminal || state.sideQuadTerminal ? 'sideDualEditor' : 'sideTerminal')
    state.setPanelLayoutMode(nextPanelLayoutMode(cycleFrom))
  },
  setSideWorkspaceColumns: patch =>
    set(state => {
      const columns = normalizeSideWorkspaceColumns({
        dualTerminal: patch.dualTerminal ?? state.sideDualTerminal,
        quadTerminal: patch.quadTerminal ?? state.sideQuadTerminal,
        editorVisible: patch.editorVisible ?? state.sideEditorVisible,
      })
      persistColumns(columns)
      return {
        ...applyColumns(columns),
        ...(patch.editorVisible === undefined ? {} : keepEditorAfterFullPage(state)),
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  toggleSideDualTerminal: () =>
    set(state => {
      const nextDual = !state.sideDualTerminal
      const columns = normalizeSideWorkspaceColumns({
        dualTerminal: nextDual,
        // Dual and 田 are mutually exclusive.
        quadTerminal: false,
        editorVisible: state.sideEditorVisible,
      })
      persistColumns({ ...columns, editorVisible: persistedEditorVisible(state) })
      return {
        ...applyColumns(columns),
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  toggleSideQuadTerminal: () =>
    set(state => {
      const nextQuad = !state.sideQuadTerminal
      const columns = normalizeSideWorkspaceColumns({
        dualTerminal: false,
        quadTerminal: nextQuad,
        editorVisible: state.sideEditorVisible,
      })
      persistColumns({ ...columns, editorVisible: persistedEditorVisible(state) })
      return {
        ...applyColumns(columns),
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  toggleSideEditorVisible: () =>
    set(state => {
      const columns = normalizeSideWorkspaceColumns({
        ...columnsFromState(state),
        editorVisible: !state.sideEditorVisible,
      })
      persistColumns(columns)
      return {
        ...applyColumns(columns),
        ...keepEditorAfterFullPage(state),
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  expandSideEditor: () =>
    set(state => {
      if (state.sideEditorVisible) return state
      const columns = normalizeSideWorkspaceColumns({
        ...columnsFromState(state),
        editorVisible: true,
      })
      persistColumns(columns)
      return applyColumns(columns)
    }),
  openProjectManager: () => set({ projectManagerOpen: true }),
  closeProjectManager: () => set({ projectManagerOpen: false }),
  openWorkspaceManager: () => set({ workspaceManagerOpen: true }),
  closeWorkspaceManager: () => set({ workspaceManagerOpen: false }),
  openRemoteConnections: () => set({ remoteConnectionsOpen: true }),
  closeRemoteConnections: () => set({ remoteConnectionsOpen: false }),
}))
