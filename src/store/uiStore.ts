import { create } from 'zustand'
import { loadActivityBarHidden, saveActivityBarHidden } from '../lib/activityBarLayout'
import {
  loadPanelLayoutTemplate,
  nextPanelLayoutTemplate,
  savePanelLayoutTemplate,
  type PanelLayoutTemplate,
} from '../lib/panelLayoutTemplate'

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
  /** Persist and switch between the bottom and side terminal layouts. */
  togglePanelLayout: () => void
  openProjectManager: () => void
  closeProjectManager: () => void
  openWorkspaceManager: () => void
  closeWorkspaceManager: () => void
}

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
  settingsFocusQuery: null,
  settingsFocusSignal: 0,
  projectManagerOpen: false,
  workspaceManagerOpen: false,
  setView: view => set({ view, sidebarOpen: true }),
  toggleActivityView: view =>
    set(state => {
      // Full-page views (SCM / Settings): click again returns to explorer.
      if (view === 'sourceControl' || view === 'settings') {
        if (state.view === view) return { view: 'explorer', sidebarOpen: true }
        return { view, sidebarOpen: true }
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
    set(state => ({
      view: 'settings',
      sidebarOpen: true,
      settingsFocusQuery: query ?? null,
      settingsFocusSignal: state.settingsFocusSignal + 1,
    })),
  openTerminalPanel: () => set(s => ({ terminalOpenSignal: s.terminalOpenSignal + 1 })),
  requestToggleTerminal: () => set(s => ({ terminalToggleSignal: s.terminalToggleSignal + 1 })),
  togglePanelLayout: () =>
    set(state => {
      const next = nextPanelLayoutTemplate(state.panelLayout)
      savePanelLayoutTemplate(next)
      return {
        panelLayout: next,
        panelLayoutSwitching: true,
        // A layout change must be visible even when the terminal was previously hidden.
        terminalOpenSignal: state.terminalOpenSignal + 1,
      }
    }),
  openProjectManager: () => set({ projectManagerOpen: true }),
  closeProjectManager: () => set({ projectManagerOpen: false }),
  openWorkspaceManager: () => set({ workspaceManagerOpen: true }),
  closeWorkspaceManager: () => set({ workspaceManagerOpen: false }),
}))
