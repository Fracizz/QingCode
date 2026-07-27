import { create } from 'zustand'
import type { DefinitionAnchor, DefinitionCandidate } from '../lib/definitionNavigation'
import type { SemanticUsageFilter } from '../lib/semanticNavigation'

export interface DefinitionPickerDetails {
  kind?: string
  origin?: string
  totalCount?: number
  filesIndexed?: number
  complete?: boolean
  truncated?: boolean
  anchor?: DefinitionAnchor
  loading?: boolean
  requestId?: number
}

export interface DefinitionUsagePage {
  candidates: DefinitionCandidate[]
  details: DefinitionPickerDetails
}

export type DefinitionUsageLoader = (
  filter: SemanticUsageFilter,
  offset: number,
  maxResults: number
) => Promise<DefinitionUsagePage>

export type DefinitionSelectionHandler = (candidate: DefinitionCandidate) => void | Promise<void>

interface DefinitionPickerState {
  open: boolean
  mode: 'definition' | 'reference'
  symbol: string
  candidates: DefinitionCandidate[]
  details: DefinitionPickerDetails | null
  usageLoader: DefinitionUsageLoader | null
  afterDefinitionJump: DefinitionSelectionHandler | null
  openPicker: (
    symbol: string,
    candidates: DefinitionCandidate[],
    mode?: 'definition' | 'reference',
    details?: DefinitionPickerDetails,
    usageLoader?: DefinitionUsageLoader,
    afterDefinitionJump?: DefinitionSelectionHandler
  ) => void
  closePicker: () => void
}

export const useDefinitionPickerStore = create<DefinitionPickerState>(set => ({
  open: false,
  mode: 'definition',
  symbol: '',
  candidates: [],
  details: null,
  usageLoader: null,
  afterDefinitionJump: null,
  openPicker: (
    symbol,
    candidates,
    mode = 'definition',
    details = {},
    usageLoader,
    afterDefinitionJump
  ) =>
    set({
      open: true,
      mode,
      symbol,
      candidates,
      details,
      usageLoader: usageLoader ?? null,
      afterDefinitionJump: afterDefinitionJump ?? null,
    }),
  closePicker: () =>
    set({
      open: false,
      mode: 'definition',
      symbol: '',
      candidates: [],
      details: null,
      usageLoader: null,
      afterDefinitionJump: null,
    }),
}))
