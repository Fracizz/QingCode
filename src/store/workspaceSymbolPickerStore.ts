import { create } from 'zustand'

interface WorkspaceSymbolPickerState {
  open: boolean
  openPicker: () => void
  closePicker: () => void
}

export const useWorkspaceSymbolPickerStore = create<WorkspaceSymbolPickerState>(set => ({
  open: false,
  openPicker: () => set({ open: true }),
  closePicker: () => set({ open: false }),
}))
