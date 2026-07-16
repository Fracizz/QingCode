export const THEME_SETTINGS_KEY = 'qingcode:theme'
export const THEME_SETTINGS_EVENT = 'qingcode:theme-changed'

export type AppTheme = 'dark' | 'light'

export const DEFAULT_THEME: AppTheme = 'dark'

export const THEMES: { label: string; value: AppTheme }[] = [
  { label: '深色', value: 'dark' },
  { label: '浅色', value: 'light' },
]

export function loadTheme(): AppTheme {
  try {
    const stored = localStorage.getItem(THEME_SETTINGS_KEY) as AppTheme | null
    return stored === 'light' ? 'light' : 'dark'
  } catch {
    return DEFAULT_THEME
  }
}

export function applyTheme(theme: AppTheme) {
  document.documentElement.setAttribute('data-theme', theme)
  window.dispatchEvent(new Event(THEME_SETTINGS_EVENT))
}

export function saveTheme(theme: AppTheme) {
  localStorage.setItem(THEME_SETTINGS_KEY, theme)
  applyTheme(theme)
}
