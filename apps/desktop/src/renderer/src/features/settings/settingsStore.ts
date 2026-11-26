import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  SettingsDensity,
} from '../../../../shared/backendApi'
import { call } from '../../lib/backend'
import { friendlyError } from '../../lib/errors'
import {
  defaultAppSettings,
  densityAttribute,
  mergeAppSettings,
  sanitizeAppSettings,
  sanitizeSettingsPatch,
} from './settingsModel'

let revision = 0
let activeSaves = 0

/** 只改 html 属性，不写样式规则：紧凑度的具体 token 覆盖由宿主 CSS 决定。 */
export function applyDensity(density: SettingsDensity): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-density', densityAttribute(density))
}

type SettingsState = {
  settings: AppSettings
  appInfo: AppInfo | null
  loaded: boolean
  loading: boolean
  saving: boolean
  error: string | null
  load: () => Promise<void>
  /** 乐观更新；保存失败回滚，有更晚的编辑在途时改为从后端重新同步。 */
  update: (patch: AppSettingsPatch) => Promise<void>
  dismissError: () => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaultAppSettings(),
  appInfo: null,
  loaded: false,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    set({ loading: true })
    try {
      const [stored, appInfo] = await Promise.all([call('settings.get'), call('app.info')])
      const settings = sanitizeAppSettings(stored)
      applyDensity(settings.general.density)
      set({ settings, appInfo, loaded: true, error: null })
    } catch (err) {
      set({ error: friendlyError(err, '加载设置失败') })
    } finally {
      set({ loading: false })
    }
  },

  update: async (patch) => {
    const previous = get().settings
    const safePatch = sanitizeSettingsPatch(patch)
    if (Object.keys(safePatch).length === 0) return
    const optimistic = mergeAppSettings(previous, safePatch)
    const currentRevision = ++revision
    activeSaves += 1
    applyDensity(optimistic.general.density)
    set({ settings: optimistic, saving: true, error: null })
    try {
      const stored = await call('settings.save', safePatch)
      const settings = sanitizeAppSettings(stored)
      applyDensity(settings.general.density)
      set({ settings })
    } catch (err) {
      const message = friendlyError(err, '保存设置失败')
      if (revision === currentRevision) {
        applyDensity(previous.general.density)
        set({ settings: previous, error: message })
      } else {
        // 更晚的编辑已经覆盖乐观值，整体回滚会丢掉它；以服务端为准重新同步。
        try {
          const settings = sanitizeAppSettings(await call('settings.get'))
          applyDensity(settings.general.density)
          set({ settings, error: message })
        } catch {
          set({ error: message })
        }
      }
    } finally {
      activeSaves -= 1
      if (activeSaves === 0) set({ saving: false })
    }
  },

  dismissError: () => set({ error: null }),
}))

/** 组件只订阅自己关心的字段，避免整个设置面板随任意字段重渲染。 */
export function useSetting<T>(selector: (settings: AppSettings) => T): T {
  return useSettings((state) => selector(state.settings))
}
