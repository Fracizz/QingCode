import { create } from 'zustand'
import type { DefinitionCandidate } from '../lib/definitionNavigation'

interface DefinitionPickerState {
  open: boolean
  symbol: string
  candidates: DefinitionCandidate[]
  openPicker: (symbol: string, candidates: DefinitionCandidate[]) => void
  closePicker: () => void
}

export const useDefinitionPickerStore = create<DefinitionPickerState>(set => ({
  open: false,
  symbol: '',
  candidates: [],
  openPicker: (symbol, candidates) => set({ open: true, symbol, candidates }),
  closePicker: () => set({ open: false, symbol: '', candidates: [] }),
}))
