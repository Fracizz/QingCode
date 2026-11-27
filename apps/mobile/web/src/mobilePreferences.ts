import { useLayoutEffect } from 'react'
import { create } from 'zustand'
import { callDevice } from './client'
import { getWindowNativePort } from './native'

export type MobileTheme = 'dark' | 'graphite' | 'light' | 'system'
type MobilePreferences = {
  theme: MobileTheme
  reduceMotion: boolean
  sendKey: 'newline' | 'send'
}

declare global {
  interface Window {
    __qnSystemTheme?: (light: boolean) => void
  }
}

const storageKey = 'qn.mobile.preferences'
const defaults: MobilePreferences = { theme: 'dark', reduceMotion: false, sendKey: 'newline' }

function readPreferences(): MobilePreferences {
  if (typeof window === 'undefined') return defaults
  try {
    const value: Partial<MobilePreferences> | null = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
    const theme = value?.theme
    return {
      theme: theme === 'graphite' || theme === 'light' || theme === 'system' ? theme : defaults.theme,
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
    const native = Boolean(getWindowNativePort())
    const system = window.matchMedia?.('(prefers-color-scheme: light)')
    let systemLight = system?.matches ?? false
    const apply = () => {
      const resolved = theme === 'system' ? (systemLight ? 'light' : 'dark') : theme
      document.documentElement.dataset.theme = resolved
      if (native) {
        // 原生桥并行处理请求，按设置顺序更新系统栏图标。
        systemBarsSync = systemBarsSync.then(async () => {
          await callDevice('appearance.systemBars', { light: resolved === 'light' })
        }).catch(() => undefined)
      }
    }
    apply()
    if (theme !== 'system') return
    const applySystem = (light: boolean) => {
      if (systemLight === light) return
      systemLight = light
      apply()
    }
    if (native) {
      let received = false
      const onSystemTheme = (light: boolean) => {
        received = true
        applySystem(light)
      }
      window.__qnSystemTheme = onSystemTheme
      void callDevice<boolean>('appearance.systemTheme').then((light) => {
        if (window.__qnSystemTheme === onSystemTheme && !received) applySystem(light)
      }).catch(() => undefined)
      return () => {
        if (window.__qnSystemTheme === onSystemTheme) delete window.__qnSystemTheme
      }
    }
    const onSystemTheme = (event: MediaQueryListEvent) => applySystem(event.matches)
    system?.addEventListener('change', onSystemTheme)
    return () => system?.removeEventListener('change', onSystemTheme)
  }, [theme])

  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-reduce-motion', reduceMotion)
  }, [reduceMotion])
}
