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
  saveSideWorkspaceColumns,
  type SideWorkspaceColumns,
} from '../lib/sideWorkspaceLayout'

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
  /** Side dock: show the editor column (independent from dual). */
  sideEditorVisible: boolean
  /** Search query for the latest Settings deep-link (e.g. files.autoSave). */
  settingsFocusQuery: string | null
  /** Incremented when opening Settings with a focus query. */
  settingsFocusSignal: number
  /** Whether the project manager modal is open. */
  projectManagerOpen: boolean
  /** Whether the named multi-project workspace manager modal is open. */
  workspaceManagerOpen: boolean
  setView: (view: View) => void
  /** Activity bar click: switch view, or collapse when clicking the active view again. */
  toggleActivityView: (view: View) => void
  setActivityBarHidden: (hidden: boolean) => void
  toggleActivityBar: () => void
  setSearchRoot: (path: string | null) => void
  /** Switch to the search view, optionally scoped to a directory. */
  requestSearch: (root?: string | null) => void
  /** Switch to the search view and focus the query input (defaults to current project). */
  requestGlobalSearch: () => void
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
  toggleSideEditorVisible: () => void
  /** Ensure the editor column is visible (open file / SCM / Settings); keeps dual. */
  expandSideEditor: () => void
  openProjectManager: () => void
  closeProjectManager: () => void
  openWorkspaceManager: () => void
  closeWorkspaceManager: () => void
}

function persistColumns(columns: SideWorkspaceColumns) {
  saveSideWorkspaceColumns(columns)
}

const initialColumns = loadSideWorkspaceColumns()

export const useUIStore = create<UIState>((set) => ({
  view: 'explorer',
  sidebarOpen: true,
  activityBarHidden: loadActivityBarHidden(),
  searchRoot: null,
  globalSearchSignal: 0,
  terminalOpenSignal: 0,
  terminalToggleSignal: 0,
  pendingNewFile: false,
  panelLayout: loadPanelLayoutTemplate(),
  panelLayoutSwitching: false,
  sideDualTerminal: initialColumns.dualTerminal,
  sideEditorVisible: initialColumns.editorVisible,
  settingsFocusQuery: null,
  settingsFocusSignal: 0,
  projectManagerOpen: false,
  workspaceManagerOpen: false,
  setView: view =>
    set(state => {
      const needsEditor = view === 'sourceControl' || view === 'settings'
      if (!needsEditor || state.sideEditorVisible) {
        return { view, sidebarOpen: true }
      }
      const columns = {
        dualTerminal: state.sideDualTerminal,
        editorVisible: true,
      }
      persistColumns(columns)
      return { view, sidebarOpen: true, sideEditorVisible: true }
    }),
  toggleActivityView: view =>
    set(state => {
      if (view === 'sourceControl' || view === 'settings') {
        if (state.view === view) return { view: 'explorer', sidebarOpen: true }
        if (!state.sideEditorVisible) {
          persistColumns({
            dualTerminal: state.sideDualTerminal,
            editorVisible: true,
          })
        }
        return {
          view,
          sidebarOpen: true,
          sideEditorVisible: true,
        }
      }
      if (state.view === view && state.sidebarOpen) return { sidebarOpen: false }
      return { view, sidebarOpen: true }
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
  requestSearch: root => set({ view: 'search', searchRoot: root ?? null, sidebarOpen: true }),
  requestGlobalSearch: () => set(state => ({
    view: 'search',
    searchRoot: null,
    sidebarOpen: true,
    globalSearchSignal: state.globalSearchSignal + 1,
  })),
  requestNewFile: () => set({ view: 'explorer', sidebarOpen: true, pendingNewFile: true }),
  clearPendingNewFile: () => set({ pendingNewFile: false }),
  requestSettings: query =>
    set(state => {
      if (!state.sideEditorVisible) {
        persistColumns({
          dualTerminal: state.sideDualTerminal,
          editorVisible: true,
        })
      }
      return {
        view: 'settings',
        sidebarOpen: true,
        sideEditorVisible: true,
        settingsFocusQuery: query ?? null,
        settingsFocusSignal: state.settingsFocusSignal + 1,
      }
    }),
  openTerminalPanel: () => set(s => ({ terminalOpenSignal: s.terminalOpenSignal + 1 })),
  requestToggleTerminal: () => set(s => ({ terminalToggleSignal: s.terminalToggleSignal + 1 })),
  setPanelLayoutMode: mode =>
    set(state => {
      const normalized = normalizePanelLayoutMode(mode)
      const current = resolvePanelLayoutMode(state.panelLayout, {
        dualTerminal: state.sideDualTerminal,
        editorVisible: state.sideEditorVisible,
      })
      if (current === normalized) return state

      const { panelLayout, columns } = panelLayoutModeParts(normalized)
      const dockChanged = state.panelLayout !== panelLayout
      savePanelLayoutTemplate(panelLayout)
      if (columns) persistColumns(columns)

      return {
        panelLayout,
        sideDualTerminal: columns ? columns.dualTerminal : state.sideDualTerminal,
        sideEditorVisible: columns ? columns.editorVisible : state.sideEditorVisible,
        panelLayoutSwitching: dockChanged,
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  togglePanelLayout: () => {
    const state = useUIStore.getState()
    const current = resolvePanelLayoutMode(state.panelLayout, {
      dualTerminal: state.sideDualTerminal,
      editorVisible: state.sideEditorVisible,
    })
    state.setPanelLayoutMode(nextPanelLayoutMode(current))
  },
  setSideWorkspaceColumns: patch =>
    set(state => {
      const columns = {
        dualTerminal: patch.dualTerminal ?? state.sideDualTerminal,
        editorVisible: patch.editorVisible ?? state.sideEditorVisible,
      }
      persistColumns(columns)
      return {
        sideDualTerminal: columns.dualTerminal,
        sideEditorVisible: columns.editorVisible,
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  toggleSideDualTerminal: () =>
    set(state => {
      const columns = {
        dualTerminal: !state.sideDualTerminal,
        editorVisible: state.sideEditorVisible,
      }
      persistColumns(columns)
      return {
        sideDualTerminal: columns.dualTerminal,
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  toggleSideEditorVisible: () =>
    set(state => {
      const columns = {
        dualTerminal: state.sideDualTerminal,
        editorVisible: !state.sideEditorVisible,
      }
      persistColumns(columns)
      return {
        sideEditorVisible: columns.editorVisible,
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  expandSideEditor: () =>
    set(state => {
      if (state.sideEditorVisible) return state
      const columns = {
        dualTerminal: state.sideDualTerminal,
        editorVisible: true,
      }
      persistColumns(columns)
      return { sideEditorVisible: true }
    }),
  openProjectManager: () => set({ projectManagerOpen: true }),
  closeProjectManager: () => set({ projectManagerOpen: false }),
  openWorkspaceManager: () => set({ workspaceManagerOpen: true }),
  closeWorkspaceManager: () => set({ workspaceManagerOpen: false }),
}))
