import { create } from 'zustand'

export interface PromptRequest {
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Return an error message, or null if valid. */
  validate?: (value: string) => string | null
}

interface PromptState {
  request: PromptRequest | null
  resolve: ((value: string | null) => void) | null
  prompt: (options: PromptRequest) => Promise<string | null>
  answer: (value: string | null) => void
}

export const usePromptStore = create<PromptState>((set, get) => ({
  request: null,
  resolve: null,
  prompt: options =>
    new Promise<string | null>(resolve => {
      set({ request: options, resolve })
    }),
  answer: value => {
    get().resolve?.(value)
    set({ request: null, resolve: null })
  },
}))

export function promptDialog(options: PromptRequest) {
  return usePromptStore.getState().prompt(options)
}

/** Reject path separators and reserved Windows names. */
export function validateEntryName(value: string): string | null {
  const name = value.trim()
  if (!name) return '名称不能为空'
  if (/[\\/:*?"<>|]/.test(name)) return '名称不能包含 \\ / : * ? " < > |'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.replace(/\.[^.]+$/, ''))) {
    return '该名称不可用'
  }
  return null
}
