export const FONT_SETTINGS_KEY = 'qingcode:font-settings'
export const FONT_SETTINGS_EVENT = 'qingcode:font-settings-changed'

export const SYSTEM_INTERFACE_FONT =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", "Microsoft YaHei", Arial, sans-serif'

export const SYSTEM_MONO_FONT =
  'ui-monospace, "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'

export const JETBRAINS_MONO_FONT =
  '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace'

export type FontOption = {
  label: string
  value: string
}

export const INTERFACE_FONT_OPTIONS: FontOption[] = [
  { label: '系统默认', value: SYSTEM_INTERFACE_FONT },
  { label: 'Segoe UI', value: '"Segoe UI", "Microsoft YaHei", sans-serif' },
  { label: 'Microsoft YaHei', value: '"Microsoft YaHei", "Segoe UI", sans-serif' },
]

export const MONO_FONT_OPTIONS: FontOption[] = [
  { label: '系统默认', value: SYSTEM_MONO_FONT },
  { label: 'JetBrains Mono', value: JETBRAINS_MONO_FONT },
  { label: 'Cascadia Code', value: '"Cascadia Code", Consolas, monospace' },
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
]

export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20] as const

export type FontSettings = {
  interfaceFont: string
  monoFont: string
  interfaceFontSize: number
  editorFontSize: number
  terminalFontSize: number
}

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  interfaceFont: SYSTEM_INTERFACE_FONT,
  monoFont: SYSTEM_MONO_FONT,
  interfaceFontSize: 13,
  editorFontSize: 13,
  terminalFontSize: 13,
}

type StoredFontSettings = Partial<FontSettings & { monoFontSize?: number }>

const LEGACY_INTERFACE_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", "Microsoft YaHei", Arial, sans-serif'

function normalizeStoredFontSettings(raw: StoredFontSettings): StoredFontSettings {
  const next = { ...raw }
  if (next.interfaceFont === LEGACY_INTERFACE_FONT) {
    next.interfaceFont = SYSTEM_INTERFACE_FONT
  }
  return next
}

export function loadFontSettings(): FontSettings {
  try {
    const raw = normalizeStoredFontSettings(
      JSON.parse(localStorage.getItem(FONT_SETTINGS_KEY) ?? '{}') as StoredFontSettings
    )
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

export function getResolvedMonoFont(): string {
  if (typeof document === 'undefined') return DEFAULT_FONT_SETTINGS.monoFont
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
    DEFAULT_FONT_SETTINGS.monoFont
  )
}

export function getResolvedTerminalFontSize(): number {
  if (typeof document === 'undefined') return DEFAULT_FONT_SETTINGS.terminalFontSize
  return (
    Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'),
      10
    ) || DEFAULT_FONT_SETTINGS.terminalFontSize
  )
}

export function saveFontSettings(settings: FontSettings) {
  localStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify(settings))
  applyFontSettings(settings)
  window.dispatchEvent(new Event(FONT_SETTINGS_EVENT))
}

/** Keep unknown persisted values selectable after preset lists change. */
export function withCurrentFontOption(options: FontOption[], value: string): FontOption[] {
  if (options.some(option => option.value === value)) return options
  return [{ label: '自定义', value }, ...options]
}
