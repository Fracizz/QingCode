import { create } from 'zustand'
import type { DefinitionCandidate } from '../lib/definitionNavigation'

interface DefinitionPickerState {
  open: boolean
  mode: 'definition' | 'reference'
  symbol: string
  candidates: DefinitionCandidate[]
  openPicker: (
    symbol: string,
    candidates: DefinitionCandidate[],
    mode?: 'definition' | 'reference'
  ) => void
  closePicker: () => void
}

export const useDefinitionPickerStore = create<DefinitionPickerState>(set => ({
  open: false,
  mode: 'definition',
  symbol: '',
  candidates: [],
  openPicker: (symbol, candidates, mode = 'definition') =>
    set({ open: true, mode, symbol, candidates }),
  closePicker: () =>
    set({ open: false, mode: 'definition', symbol: '', candidates: [] }),
}))
