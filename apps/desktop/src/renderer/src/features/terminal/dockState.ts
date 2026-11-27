import { create } from 'zustand'

export const TERMINAL_SHORTCUT = 'Ctrl+`'

type TerminalProject = { targetId: string; cwd: string }

export const useTerminalDock = create<{
  open: boolean
  newRequest: TerminalProject | null
  openNew: (project: TerminalProject | null) => void
  toggle: () => void
  close: () => void
}>((set) => ({
  open: false,
  newRequest: null,
  openNew: (project) => set({ open: true, newRequest: project }),
  toggle: () => set((state) => ({ open: !state.open, newRequest: null })),
  close: () => set({ open: false, newRequest: null }),
}))
