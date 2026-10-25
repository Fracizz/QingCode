import { create } from 'zustand'

interface SymbolPickerState {
  open: boolean
  openPicker: () => void
  closePicker: () => void
}

export const useSymbolPickerStore = create<SymbolPickerState>(set => ({
  open: false,
  openPicker: () => set({ open: true }),
  closePicker: () => set({ open: false }),
}))
