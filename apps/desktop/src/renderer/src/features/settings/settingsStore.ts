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

function applyAppearance(general: AppSettings['general']): void {
  if (typeof document === 'undefined') return
  applyDensity(general.density)
  const { style } = document.documentElement
  style.setProperty('--qn-chat-font-size', `${general.chatFontSize}px`)
  style.setProperty('--qn-composer-font-size', `${general.composerFontSize}px`)
  style.setProperty('--qn-editor-font-size', `${general.editorFontSize}px`)
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
      applyAppearance(settings.general)
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
    const overlapping = activeSaves > 0
    activeSaves += 1
    applyAppearance(optimistic.general)
    set({ settings: optimistic, saving: true, error: null })
    try {
      const stored = await call('settings.save', safePatch)
      if (revision === currentRevision) {
        const settings = sanitizeAppSettings(stored)
        applyAppearance(settings.general)
        set({ settings })
      }
    } catch (err) {
      const message = friendlyError(err, '保存设置失败')
      if (revision === currentRevision && !overlapping) {
        applyAppearance(previous.general)
        set({ settings: previous, error: message })
      } else if (revision === currentRevision || activeSaves === 1) {
        // 多个补丁的乐观值可能交叠，需要以落盘结果为准。
        const syncRevision = revision
        try {
          const settings = sanitizeAppSettings(await call('settings.get'))
          if (revision === syncRevision) {
            applyAppearance(settings.general)
            set({ settings, error: message })
          }
        } catch {
          set({ error: message })
        }
      } else {
        set({ error: message })
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
