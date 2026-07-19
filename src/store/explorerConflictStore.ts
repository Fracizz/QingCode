import { create } from 'zustand'

export type ExplorerConflictResult =
  | { action: 'overwrite' }
  | { action: 'overwrite_all' }
  | { action: 'skip' }
  | { action: 'skip_all' }
  | { action: 'rename'; newName: string }
  | { action: 'cancel' }

export type ExplorerConflictRequest = {
  title: string
  message: string
  detail?: string
  /** Prefill for the rename input (e.g. `foo - Copy.txt`). */
  defaultName: string
  /** Original conflicting basename — rename must differ. */
  originalName: string
  showApplyAll: boolean
}

type ExplorerConflictState = {
  request: ExplorerConflictRequest | null
  resolve: ((value: ExplorerConflictResult) => void) | null
  open: (options: ExplorerConflictRequest) => Promise<ExplorerConflictResult>
  answer: (value: ExplorerConflictResult) => void
}

export const useExplorerConflictStore = create<ExplorerConflictState>((set, get) => ({
  request: null,
  resolve: null,
  open: options =>
    new Promise<ExplorerConflictResult>(resolve => {
      set({ request: options, resolve })
    }),
  answer: value => {
    get().resolve?.(value)
    set({ request: null, resolve: null })
  },
}))

export function explorerConflictDialog(options: ExplorerConflictRequest) {
  return useExplorerConflictStore.getState().open(options)
}
