import { create } from 'zustand'

export type ConfirmKind = 'warning' | 'danger' | 'info'

/** `true` = primary confirm, `false` = cancel, `'alt'` = optional third action. */
export type ConfirmResult = boolean | 'alt'

export interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  kind?: ConfirmKind
  confirmLabel?: string
  cancelLabel?: string
  /** Optional third action (e.g. trust project). Resolves as `'alt'`. */
  altLabel?: string
}

interface ConfirmState {
  request: ConfirmRequest | null
  resolve: ((value: ConfirmResult) => void) | null
  confirm: (options: ConfirmRequest) => Promise<ConfirmResult>
  answer: (value: ConfirmResult) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolve: null,
  confirm: options =>
    new Promise<ConfirmResult>(resolve => {
      set({ request: options, resolve })
    }),
  answer: value => {
    get().resolve?.(value)
    set({ request: null, resolve: null })
  },
}))

/** Two-button confirm (no `altLabel`). */
export function confirmDialog(options: ConfirmRequest & { altLabel?: undefined }): Promise<boolean>
/** Three-button confirm when `altLabel` is set. */
export function confirmDialog(options: ConfirmRequest & { altLabel: string }): Promise<ConfirmResult>
export function confirmDialog(options: ConfirmRequest): Promise<ConfirmResult> {
  return useConfirmStore.getState().confirm(options)
}
