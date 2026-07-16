import { create } from 'zustand'

export type View = 'explorer' | 'search' | 'run' | 'settings'

interface UIState {
  view: View
  /** When set, search is restricted to this directory path (absolute). */
  searchRoot: string | null
  /** Incremented to request the terminal panel to open (e.g. when a run config starts). */
  terminalOpenSignal: number
  /** Whether the project manager modal is open. */
  projectManagerOpen: boolean
  setView: (view: View) => void
  setSearchRoot: (path: string | null) => void
  /** Switch to the search view, optionally scoped to a directory. */
  requestSearch: (root?: string | null) => void
  /** Request the terminal panel to open. */
  openTerminalPanel: () => void
  openProjectManager: () => void
  closeProjectManager: () => void
}

export const useUIStore = create<UIState>((set) => ({
  view: 'explorer',
  searchRoot: null,
  terminalOpenSignal: 0,
  projectManagerOpen: false,
  setView: view => set({ view }),
  setSearchRoot: path => set({ searchRoot: path }),
  requestSearch: root => set({ view: 'search', searchRoot: root ?? null }),
  openTerminalPanel: () => set(s => ({ terminalOpenSignal: s.terminalOpenSignal + 1 })),
  openProjectManager: () => set({ projectManagerOpen: true }),
  closeProjectManager: () => set({ projectManagerOpen: false }),
}))
