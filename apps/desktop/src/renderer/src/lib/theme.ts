import type { SettingsTheme } from '../../../shared/backendApi'

// 主题只切 html[data-theme]，具体颜色全在 styles.css 的 token 里；这里负责缓存、广播与系统标题栏同步。

export const THEME_STORAGE_KEY = 'qn-theme'
/** 主题变化后派发在 window 上，xterm 这类不读 CSS 变量的组件据此重新取色。 */
export const THEME_CHANGE_EVENT = 'qn-theme-change'
/** 进场页开始淡出时派发；进场页固定深色，系统标题栏要等它淡出再跟随主题。 */
export const SPLASH_LEAVE_EVENT = 'qn-splash-leave'

export function isTheme(value: unknown): value is SettingsTheme {
  return value === 'dark' || value === 'gray' || value === 'light'
}

/** 设置还没从后端读回时先用上次的主题，避免浅色用户每次启动先闪一下深色界面。 */
export function readCachedTheme(): SettingsTheme {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    return isTheme(value) ? value : 'dark'
  } catch {
    return 'dark'
  }
}

export function currentTheme(): SettingsTheme {
  if (typeof document === 'undefined') return 'dark'
  const value = document.documentElement.getAttribute?.('data-theme')
  return isTheme(value) ? value : 'dark'
}

let chromeTheme: SettingsTheme | null = null
let waitingSplash = false

function syncWindowChrome(): void {
  const theme = currentTheme()
  if (chromeTheme === theme) return
  chromeTheme = theme
  window.qn?.setTheme?.(theme)
}

function scheduleWindowChrome(): void {
  if (!document.getElementById?.('qn-splash')) {
    syncWindowChrome()
    return
  }
  if (waitingSplash) return
  waitingSplash = true
  window.addEventListener(
    SPLASH_LEAVE_EVENT,
    () => {
      waitingSplash = false
      syncWindowChrome()
    },
    { once: true },
  )
}

export function applyTheme(theme: SettingsTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const changed = root.getAttribute?.('data-theme') !== theme
  root.setAttribute('data-theme', theme)
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 存储不可用时只是下次启动会先按深色绘制，不影响当前会话。
  }
  if (typeof window === 'undefined') return
  if (changed) window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  scheduleWindowChrome()
}
