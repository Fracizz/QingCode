export const THEME_SETTINGS_KEY = 'qingcode:theme'
export const THEME_SETTINGS_EVENT = 'qingcode:theme-changed'

export type AppTheme = 'dark' | 'light' | 'olive' | 'forest' | 'auto'
export type ResolvedTheme = 'dark' | 'light' | 'olive'

export const DEFAULT_THEME: AppTheme = 'dark'

export const THEMES: { label: string; value: AppTheme; hint: string }[] = [
  { label: '深色', value: 'dark', hint: '常驻深色' },
  { label: '浅色', value: 'light', hint: '常驻浅色' },
  { label: '橄榄绿', value: 'olive', hint: '雅致橄榄绿（自然舒适）' },
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
    const stored = localStorage.getItem(THEME_SETTINGS_KEY) as string | null
    if (stored === 'forest') {
      try { localStorage.setItem(THEME_SETTINGS_KEY, 'olive') } catch {}
      return 'olive'
    }
    if (stored === 'light' || stored === 'dark' || stored === 'olive' || stored === 'auto') {
      return stored as AppTheme
    }
  } catch {}
  return DEFAULT_THEME
}

export function getResolvedTheme(theme: AppTheme = loadTheme()): ResolvedTheme {
  if (theme === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  if (theme === 'olive' || theme === 'forest') return 'olive'
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
