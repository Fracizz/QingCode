import { create } from 'zustand'
import type { GitStatus } from '../lib/git'

type SourceControlState = {
  /** Project path the cached status belongs to. */
  cachedPath: string | null
  cachedStatus: GitStatus | null
  setCache: (path: string, status: GitStatus) => void
  clearCache: (path?: string) => void
}

/** Last full `git_status` snapshot for soft-open of the Source Control panel. */
export const useSourceControlStore = create<SourceControlState>((set, get) => ({
  cachedPath: null,
  cachedStatus: null,

  setCache: (path, status) => {
    set({ cachedPath: path, cachedStatus: status })
  },

  clearCache: path => {
    if (path === undefined || get().cachedPath === path) {
      set({ cachedPath: null, cachedStatus: null })
    }
  },
}))

export function peekSourceControlCache(path: string): GitStatus | null {
  const state = useSourceControlStore.getState()
  return state.cachedPath === path ? state.cachedStatus : null
}
