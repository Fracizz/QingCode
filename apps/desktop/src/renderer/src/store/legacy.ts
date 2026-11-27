import { t } from '@qn/codex-client'
import { create } from 'zustand'
import type { LegacyDetectResult, LegacyImportResult } from '../../../shared/backendApi'
import { call } from '../lib/backend'
import { friendlyError, isNotImplemented } from '../lib/errors'
import { useProjects } from './projects'
import { useTargets } from './targets'

const DISMISS_KEY = 'qn-legacy-banner-dismissed'

type LegacyState = {
  detect: LegacyDetectResult | null
  dismissed: boolean
  dialogOpen: boolean
  path: string
  includeSecrets: boolean
  busy: boolean
  error: string | null
  result: LegacyImportResult | null
  detectNow: (path?: string) => Promise<void>
  open: () => void
  close: () => void
  dismiss: () => void
  setPath: (path: string) => void
  setIncludeSecrets: (value: boolean) => void
  pickFile: () => Promise<void>
  runImport: () => Promise<void>
}

const readDismissed = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export const useLegacy = create<LegacyState>((set, get) => ({
  detect: null,
  dismissed: readDismissed(),
  dialogOpen: false,
  path: '',
  includeSecrets: false,
  busy: false,
  error: null,
  result: null,

  detectNow: async (path) => {
    try {
      const detect = await call('legacy.detect', path ? { path } : {})
      set((state) => ({
        detect,
        path: path ?? (state.path || detect.path),
        error: null,
      }))
    } catch (err) {
      // T8 尚未接入时不打扰用户，横幅保持隐藏。
      if (isNotImplemented(err)) {
        set({ detect: null, error: null })
        return
      }
      set({ error: friendlyError(err, t('检测旧版数据失败')) })
    }
  },

  open: () => {
    set({ dialogOpen: true, result: null, error: null })
    if (!get().detect) void get().detectNow()
  },

  close: () => set({ dialogOpen: false }),

  dismiss: () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // 隐私模式下 localStorage 不可用，仅本次会话内隐藏。
    }
    set({ dismissed: true })
  },

  setPath: (path) => set({ path }),
  setIncludeSecrets: (includeSecrets) => set({ includeSecrets }),

  pickFile: async () => {
    if (typeof window === 'undefined') return
    try {
      const picked = await window.qn.openFile('legacyDb')
      if (!picked) return
      set({ path: picked, result: null })
      await get().detectNow(picked)
    } catch (err) {
      set({ error: friendlyError(err, t('选择文件失败')) })
    }
  },

  runImport: async () => {
    set({ busy: true, error: null, result: null })
    try {
      const { path, includeSecrets } = get()
      const result = await call('legacy.import', {
        ...(path ? { path } : {}),
        includeSecrets,
      })
      set({ result, busy: false })
      await useTargets.getState().load()
      await useProjects.getState().reloadAll()
    } catch (err) {
      set({ busy: false, error: friendlyError(err, t('导入旧版数据失败')) })
    }
  },
}))
