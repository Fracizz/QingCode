import { create } from 'zustand'

export type View = 'explorer' | 'search' | 'run' | 'settings'

interface UIState {
  view: View
  /** Whether the left sidebar panel is visible (VS Code-style toggle). */
  sidebarOpen: boolean
  /** When set, search is restricted to this directory path (absolute). */
  searchRoot: string | null
  /** Incremented when the search shortcut opens the search view. */
  globalSearchSignal: number
  /** Incremented to request the terminal panel to open (e.g. when a run config starts). */
  terminalOpenSignal: number
  /** Whether the project manager modal is open. */
  projectManagerOpen: boolean
  setView: (view: View) => void
  /** Activity bar click: switch view, or collapse when clicking the active view again. */
  toggleActivityView: (view: View) => void
  setSearchRoot: (path: string | null) => void
  /** Switch to the search view, optionally scoped to a directory. */
  requestSearch: (root?: string | null) => void
  /** Switch to the search view and focus the query input (defaults to current project). */
  requestGlobalSearch: () => void
  /** Request the terminal panel to open. */
  openTerminalPanel: () => void
  openProjectManager: () => void
  closeProjectManager: () => void
}

export const useUIStore = create<UIState>((set) => ({
  view: 'explorer',
  sidebarOpen: true,
  searchRoot: null,
  globalSearchSignal: 0,
  terminalOpenSignal: 0,
  projectManagerOpen: false,
  setView: view => set({ view, sidebarOpen: true }),
  toggleActivityView: view =>
    set(state => {
      if (state.view === view && state.sidebarOpen) return { sidebarOpen: false }
      return { view, sidebarOpen: true }
    }),
  setSearchRoot: path => set({ searchRoot: path }),
  requestSearch: root => set({ view: 'search', searchRoot: root ?? null, sidebarOpen: true }),
  requestGlobalSearch: () => set(state => ({
    view: 'search',
    searchRoot: null,
    sidebarOpen: true,
    globalSearchSignal: state.globalSearchSignal + 1,
  })),
  openTerminalPanel: () => set(s => ({ terminalOpenSignal: s.terminalOpenSignal + 1 })),
  openProjectManager: () => set({ projectManagerOpen: true }),
  closeProjectManager: () => set({ projectManagerOpen: false }),
}))
