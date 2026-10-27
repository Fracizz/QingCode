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
  checkbox?: { label: string; detail?: string; defaultChecked: boolean }
  /** Cancel only this confirmation when its owning operation is superseded. */
  signal?: AbortSignal
}

export type CheckboxConfirmResult = { confirmed: boolean; checked: boolean }

interface ConfirmState {
  request: ConfirmRequest | null
  resolve: ((value: ConfirmResult) => void) | null
  confirm: (options: ConfirmRequest) => Promise<ConfirmResult>
  answer: (value: ConfirmResult) => void
  checkboxChecked: boolean
  setCheckboxChecked: (checked: boolean) => void
  confirmWithCheckbox: (options: ConfirmRequest) => Promise<CheckboxConfirmResult>
}

export const useConfirmStore = create<ConfirmState>((set, get) => {
  const request = (options: ConfirmRequest) => new Promise<{ value: ConfirmResult; checked: boolean }>(resolve => {
    const { signal } = options
    if (signal?.aborted) {
      resolve({ value: false, checked: false })
      return
    }
    let settled = false
    const finish = (value: ConfirmResult) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve({ value, checked: get().checkboxChecked })
    }
    const onAbort = () => {
      if (get().resolve === finish) get().answer(false)
      else finish(false)
    }
    set({ request: options, resolve: finish, checkboxChecked: options.checkbox?.defaultChecked ?? false })
    // Store subscribers may synchronously cancel the owning operation.
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
  return {
    request: null,
    resolve: null,
    checkboxChecked: false,
    setCheckboxChecked: checkboxChecked => set({ checkboxChecked }),
    confirm: options => request(options).then(result => result.value),
    confirmWithCheckbox: options => request(options).then(result => ({
      confirmed: result.value === true, checked: result.checked,
    })),
    answer: value => {
      get().resolve?.(value)
      set({ request: null, resolve: null })
    },
  }
})

/** Two-button confirm (no `altLabel`). */
export function confirmDialog(options: ConfirmRequest & { altLabel?: undefined }): Promise<boolean>
/** Three-button confirm when `altLabel` is set. */
export function confirmDialog(options: ConfirmRequest & { altLabel: string }): Promise<ConfirmResult>
export function confirmDialog(options: ConfirmRequest): Promise<ConfirmResult> {
  return useConfirmStore.getState().confirm(options)
}

export function confirmDialogWithCheckbox(
  options: ConfirmRequest & { checkbox: NonNullable<ConfirmRequest['checkbox']>; altLabel?: undefined },
): Promise<CheckboxConfirmResult> {
  return useConfirmStore.getState().confirmWithCheckbox(options)
}
