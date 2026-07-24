import { create } from 'zustand'
import type { DefinitionTarget } from '../lib/gotoDefinition/types'

interface DefinitionPickerState {
  open: boolean
  targets: DefinitionTarget[]
  openWith: (targets: DefinitionTarget[]) => void
  closePicker: () => void
}

export const useDefinitionPickerStore = create<DefinitionPickerState>(set => ({
  open: false,
  targets: [],
  openWith: targets => set({ open: true, targets }),
  closePicker: () => set({ open: false, targets: [] }),
}))
