export const FONT_SETTINGS_KEY = 'qingcode:font-settings'
export const FONT_SETTINGS_EVENT = 'qingcode:font-settings-changed'

export type FontSettings = {
  interfaceFont: string
  monoFont: string
  interfaceFontSize: number
  editorFontSize: number
  terminalFontSize: number
}

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  interfaceFont:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", "Microsoft YaHei", Arial, sans-serif',
  monoFont: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  interfaceFontSize: 13,
  editorFontSize: 13,
  terminalFontSize: 13,
}

type StoredFontSettings = Partial<FontSettings & { monoFontSize?: number }>

export function loadFontSettings(): FontSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(FONT_SETTINGS_KEY) ?? '{}') as StoredFontSettings
    const legacyMono = raw.monoFontSize
    return {
      ...DEFAULT_FONT_SETTINGS,
      ...raw,
      editorFontSize: raw.editorFontSize ?? legacyMono ?? DEFAULT_FONT_SETTINGS.editorFontSize,
      terminalFontSize: raw.terminalFontSize ?? legacyMono ?? DEFAULT_FONT_SETTINGS.terminalFontSize,
    }
  } catch {
    return DEFAULT_FONT_SETTINGS
  }
}

export function applyFontSettings(settings: FontSettings) {
  document.documentElement.style.setProperty('--font-sans', settings.interfaceFont)
  document.documentElement.style.setProperty('--font-mono', settings.monoFont)
  document.documentElement.style.setProperty('--ui-font-size', `${settings.interfaceFontSize}px`)
  document.documentElement.style.setProperty('--ui-font-scale', String(settings.interfaceFontSize / 13))
  document.documentElement.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`)
  document.documentElement.style.setProperty('--terminal-font-size', `${settings.terminalFontSize}px`)
}

export function saveFontSettings(settings: FontSettings) {
  localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify(settings))
  applyFontSettings(settings)
  window.dispatchEvent(new Event(FONT_SETTINGS_EVENT))
}
