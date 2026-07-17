import { create } from 'zustand'
import type { FileCompareRequest } from '../components/FileCompareDialog'

type CompareState = {
  request: FileCompareRequest | null
  openCompare: (request: FileCompareRequest) => void
  closeCompare: () => void
}

export const useCompareStore = create<CompareState>(set => ({
  request: null,
  openCompare: request => set({ request }),
  closeCompare: () => set({ request: null }),
}))
