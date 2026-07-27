import { create } from 'zustand'

interface WorkspaceSymbolPickerState {
  open: boolean
  seedQuery: string
  openPicker: (seedQuery?: string) => void
  closePicker: () => void
}

export const useWorkspaceSymbolPickerStore = create<WorkspaceSymbolPickerState>(set => ({
  open: false,
  seedQuery: '',
  openPicker: (seedQuery = '') => set({ open: true, seedQuery: seedQuery.trim() }),
  closePicker: () => set({ open: false, seedQuery: '' }),
}))
