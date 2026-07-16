import { create } from 'zustand'

export type View = 'explorer' | 'search' | 'run' | 'settings'

interface UIState {
  view: View
  /** When set, search is restricted to this directory path (absolute). */
  searchRoot: string | null
  /** Incremented to request the terminal panel to open (e.g. when a run config starts). */
  terminalOpenSignal: number
  setView: (view: View) => void
  setSearchRoot: (path: string | null) => void
  /** Switch to the search view, optionally scoped to a directory. */
  requestSearch: (root?: string | null) => void
  /** Request the terminal panel to open. */
  openTerminalPanel: () => void
}

export const useUIStore = create<UIState>((set) => ({
  view: 'explorer',
  searchRoot: null,
  terminalOpenSignal: 0,
  setView: view => set({ view }),
  setSearchRoot: path => set({ searchRoot: path }),
  requestSearch: root => set({ view: 'search', searchRoot: root ?? null }),
  openTerminalPanel: () => set(s => ({ terminalOpenSignal: s.terminalOpenSignal + 1 })),
}))
