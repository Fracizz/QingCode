import { create } from 'zustand'
import { DEFAULT_CONFIG, type GitPushSyncConfig } from './core'
import type { SyncResult } from './engine'

export type DetectionState = 'live' | 'waiting' | 'panel-only'
export type Detection = { state: DetectionState; detail: string | null }

type GitPushSyncState = {
  config: GitPushSyncConfig
  detection: Record<string, Detection>
  results: Record<string, SyncResult>
  setConfig: (config: GitPushSyncConfig) => void
  setDetection: (path: string, detection: Detection) => void
  setResult: (path: string, result: SyncResult) => void
}

export const useGitPushSyncStore = create<GitPushSyncState>(set => ({
  config: DEFAULT_CONFIG,
  detection: {},
  results: {},
  setConfig: config => set({ config }),
  setDetection: (path, detection) =>
    set(state => ({ detection: { ...state.detection, [path]: detection } })),
  setResult: (path, result) => set(state => ({ results: { ...state.results, [path]: result } })),
}))
