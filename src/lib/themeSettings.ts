export const THEME_SETTINGS_KEY = 'qingcode:theme'
export const THEME_SETTINGS_EVENT = 'qingcode:theme-changed'

export type AppTheme = 'dark' | 'light' | 'forest' | 'auto'
export type ResolvedTheme = 'dark' | 'light' | 'forest'

export const DEFAULT_THEME: AppTheme = 'dark'

export const THEMES: { label: string; value: AppTheme; hint: string }[] = [
  { label: '深色', value: 'dark', hint: '常驻深色' },
  { label: '浅色', value: 'light', hint: '常驻浅色' },
  { label: '森林', value: 'forest', hint: '深绿 Material Forest（IDEA 同款）' },
  { label: '跟随系统', value: 'auto', hint: '随操作系统明暗自动切换' },
]

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export function loadTheme(): AppTheme {
  try {
    const stored = localStorage.getItem(THEME_SETTINGS_KEY) as AppTheme | null
    if (stored === 'light' || stored === 'dark' || stored === 'forest' || stored === 'auto') {
      return stored
    }
  } catch {}
  return DEFAULT_THEME
}

export function getResolvedTheme(theme: AppTheme = loadTheme()): ResolvedTheme {
  if (theme === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  if (theme === 'forest') return 'forest'
  return theme
}

export function applyTheme(theme: AppTheme) {
  const resolved = getResolvedTheme(theme)
  const root = document.documentElement
  // Enable color transitions only around the switch so drag/hover states stay snappy.
  root.classList.add('theme-transition')
  root.setAttribute('data-theme', resolved)
  window.setTimeout(() => root.classList.remove('theme-transition'), 260)
  window.dispatchEvent(
    new CustomEvent(THEME_SETTINGS_EVENT, { detail: { theme, resolved } }),
  )
}

export function saveTheme(theme: AppTheme) {
  try {
    localStorage.setItem(THEME_SETTINGS_KEY, theme)
  } catch {}
  applyTheme(theme)
}

let systemListenerBound = false
/** 当用户选择"跟随系统"时，监听操作系统明暗变化实时切换。 */
export function startSystemThemeListener() {
  if (systemListenerBound || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return
  }
  systemListenerBound = true
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    if (loadTheme() === 'auto') applyTheme('auto')
  }
  if (mq.addEventListener) mq.addEventListener('change', handler)
  else mq.addListener(handler)
}
