import { create } from 'zustand'

/** Memory only: drafts survive view/project switches, not app restarts. */
export const useTerminalDraftStore = create<{
  drafts: Record<string, string>
  setDraft: (id: string, text: string) => void
  clearDraft: (id: string) => void
}>(set => ({
  drafts: {},
  setDraft: (id, text) => set(state => ({ drafts: { ...state.drafts, [id]: text } })),
  clearDraft: id =>
    set(state => {
      const drafts = { ...state.drafts }
      delete drafts[id]
      return { drafts }
    }),
}))
