import { create } from 'zustand'

export type ChoiceOption = {
  id: string
  label: string
  /** Visual emphasis for the primary action. */
  primary?: boolean
  danger?: boolean
}

export interface ChoiceRequest {
  title: string
  message: string
  detail?: string
  options: ChoiceOption[]
}

interface ChoiceState {
  request: ChoiceRequest | null
  resolve: ((value: string | null) => void) | null
  choose: (options: ChoiceRequest) => Promise<string | null>
  answer: (value: string | null) => void
}

export const useChoiceStore = create<ChoiceState>((set, get) => ({
  request: null,
  resolve: null,
  choose: options =>
    new Promise<string | null>(resolve => {
      set({ request: options, resolve })
    }),
  answer: value => {
    get().resolve?.(value)
    set({ request: null, resolve: null })
  },
}))

export function choiceDialog(options: ChoiceRequest) {
  return useChoiceStore.getState().choose(options)
}
