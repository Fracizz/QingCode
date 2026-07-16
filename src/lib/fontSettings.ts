export const FONT_SETTINGS_KEY = 'qingcode:font-settings'
export const FONT_SETTINGS_EVENT = 'qingcode:font-settings-changed'

export type FontSettings = {
  interfaceFont: string
  monoFont: string
  interfaceFontSize: number
  monoFontSize: number
}

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  interfaceFont:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", "Microsoft YaHei", Arial, sans-serif',
  monoFont: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  interfaceFontSize: 13,
  monoFontSize: 13,
}

export function loadFontSettings(): FontSettings {
  try {
    return { ...DEFAULT_FONT_SETTINGS, ...JSON.parse(localStorage.getItem(FONT_SETTINGS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_FONT_SETTINGS
  }
}

export function applyFontSettings(settings: FontSettings) {
  document.documentElement.style.setProperty('--font-sans', settings.interfaceFont)
  document.documentElement.style.setProperty('--font-mono', settings.monoFont)
  document.documentElement.style.setProperty('--ui-font-size', `${settings.interfaceFontSize}px`)
  document.documentElement.style.setProperty('--ui-font-scale', String(settings.interfaceFontSize / 13))
  document.documentElement.style.setProperty('--mono-font-size', `${settings.monoFontSize}px`)
}

export function saveFontSettings(settings: FontSettings) {
  localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify(settings))
  applyFontSettings(settings)
  window.dispatchEvent(new Event(FONT_SETTINGS_EVENT))
}
