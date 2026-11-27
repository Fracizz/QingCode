import { useLayoutEffect } from 'react'
import { create } from 'zustand'
import { callDevice } from './client'
import { getWindowNativePort } from './native'

/** 与电脑版主题一致：深色（默认）、灰色、浅色。 */
export type MobileTheme = 'dark' | 'gray' | 'light'
type MobilePreferences = {
  theme: MobileTheme
  reduceMotion: boolean
  sendKey: 'newline' | 'send'
}

const storageKey = 'qn.mobile.preferences'
const defaults: MobilePreferences = { theme: 'dark', reduceMotion: false, sendKey: 'newline' }

/** 旧版存过「石墨灰」（graphite）和「跟随系统」（system）：前者并入灰色，后者回到默认深色。 */
export function parseTheme(value: unknown): MobileTheme {
  if (value === 'gray' || value === 'graphite') return 'gray'
  return value === 'light' ? 'light' : defaults.theme
}

function readPreferences(): MobilePreferences {
  if (typeof window === 'undefined') return defaults
  try {
    const value: Partial<Record<keyof MobilePreferences, unknown>> | null = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    return {
      theme: parseTheme(value?.theme),
      reduceMotion: value?.reduceMotion === true,
      sendKey: value?.sendKey === 'send' ? 'send' : defaults.sendKey,
    }
  } catch {
    return defaults
  }
}

export const useMobilePreferences = create<MobilePreferences & {
  update: (values: Partial<MobilePreferences>) => boolean
}>((set, get) => ({
  ...readPreferences(),
  update: (values) => {
    const { theme, reduceMotion, sendKey } = get()
    const next = { theme, reduceMotion, sendKey, ...values }
    set(next)
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next))
      return true
    } catch {
      return false
    }
  },
}))

let systemBarsSync = Promise.resolve()

export function useMobileAppearance() {
  const theme = useMobilePreferences((state) => state.theme)
  const reduceMotion = useMobilePreferences((state) => state.reduceMotion)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    if (!getWindowNativePort()) return
    // 原生桥并行处理请求，按设置顺序更新系统栏图标。
    systemBarsSync = systemBarsSync.then(async () => {
      await callDevice('appearance.systemBars', { light: theme === 'light' })
    }).catch(() => undefined)
  }, [theme])

  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduceMotion)
  }, [reduceMotion])
}
