import { create } from 'zustand'

export type ConfirmKind = 'warning' | 'danger' | 'info'

export interface ConfirmRequest {
  title: string
  message: string
  detail?: string
  kind?: ConfirmKind
  confirmLabel?: string
  cancelLabel?: string
}

interface ConfirmState {
  request: ConfirmRequest | null
  resolve: ((value: boolean) => void) | null
  confirm: (options: ConfirmRequest) => Promise<boolean>
  answer: (value: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolve: null,
  confirm: options =>
    new Promise<boolean>(resolve => {
      set({ request: options, resolve })
    }),
  answer: value => {
    get().resolve?.(value)
    set({ request: null, resolve: null })
  },
}))

export function confirmDialog(options: ConfirmRequest) {
  return useConfirmStore.getState().confirm(options)
}
