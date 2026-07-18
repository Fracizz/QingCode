import { create } from 'zustand'

interface CommandPaletteState {
  open: boolean
  /** Seed input when opening (e.g. `> ` for command-only mode). */
  seedQuery: string
  openPalette: (seedQuery?: string) => void
  closePalette: () => void
  togglePalette: () => void
}

export const useCommandPaletteStore = create<CommandPaletteState>(set => ({
  open: false,
  seedQuery: '',
  openPalette: (seedQuery = '') => set({ open: true, seedQuery }),
  closePalette: () => set({ open: false, seedQuery: '' }),
  togglePalette: () => set(state => ({ open: !state.open, seedQuery: '' })),
}))
