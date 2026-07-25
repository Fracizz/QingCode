import { create } from 'zustand'
import type { DefinitionAnchor, DefinitionCandidate } from '../lib/definitionNavigation'

interface DefinitionPreviewPayload {
  requestId: number
  symbol: string
  anchor: DefinitionAnchor
  candidates?: DefinitionCandidate[]
  onFindUsages?: () => void | Promise<void>
}

interface DefinitionPreviewState {
  open: boolean
  loading: boolean
  pinned: boolean
  pointerInside: boolean
  modifierHeld: boolean
  requestId: number
  symbol: string
  anchor: DefinitionAnchor | null
  candidates: DefinitionCandidate[]
  onFindUsages: (() => void | Promise<void>) | null
  beginPreview: (payload: DefinitionPreviewPayload) => void
  completePreview: (requestId: number, candidates: DefinitionCandidate[]) => void
  failPreview: (requestId: number) => void
  setPointerInside: (inside: boolean) => void
  setModifierHeld: (held: boolean) => void
  setPinned: (pinned: boolean) => void
  closePreview: (force?: boolean) => void
}

const CLOSED_PREVIEW: Pick<
  DefinitionPreviewState,
  | 'open'
  | 'loading'
  | 'pinned'
  | 'pointerInside'
  | 'symbol'
  | 'anchor'
  | 'candidates'
  | 'onFindUsages'
> = {
  open: false,
  loading: false,
  pinned: false,
  pointerInside: false,
  symbol: '',
  anchor: null,
  candidates: [],
  onFindUsages: null,
}

export const useDefinitionPreviewStore = create<DefinitionPreviewState>(set => ({
  ...CLOSED_PREVIEW,
  modifierHeld: false,
  requestId: 0,
  beginPreview: payload =>
    set({
      open: true,
      loading: true,
      pinned: false,
      requestId: payload.requestId,
      symbol: payload.symbol,
      anchor: payload.anchor,
      candidates: payload.candidates ?? [],
      onFindUsages: payload.onFindUsages ?? null,
    }),
  completePreview: (requestId, candidates) =>
    set(state =>
      state.requestId === requestId
        ? {
            loading: false,
            open: candidates.length > 0,
            candidates,
          }
        : state
    ),
  failPreview: requestId =>
    set(state => (state.requestId === requestId ? { ...CLOSED_PREVIEW } : state)),
  setPointerInside: pointerInside => set({ pointerInside }),
  setModifierHeld: modifierHeld => set({ modifierHeld }),
  setPinned: pinned => set({ pinned }),
  closePreview: (force = false) =>
    set(state => {
      if (!force && (state.pinned || state.pointerInside)) return state
      return { ...CLOSED_PREVIEW, modifierHeld: state.modifierHeld }
    }),
}))
