export const FONT_SETTINGS_KEY = 'qingcode:font-settings'
export const FONT_SETTINGS_EVENT = 'qingcode:font-settings-changed'

export const SYSTEM_INTERFACE_FONT =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Segoe UI Variable", "Microsoft YaHei", Arial, sans-serif'

/** Prefer concrete faces first — `ui-monospace` can resolve differently in WebView2 vs Chrome. */
export const SYSTEM_MONO_FONT =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'

/** Concrete mono stack for xterm cell metrics (avoid generic `ui-monospace`). */
export const TERMINAL_MONO_FONT =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'

/** Families known to keep stable cell metrics for TUI / box-drawing in xterm. */
const SAFE_TERMINAL_FONT_NAMES = new Set([
  'cascadia mono',
  'cascadia code',
  'consolas',
  'courier new',
  'jetbrains mono',
  'fira code',
  'fira mono',
  'source code pro',
  'ibm plex mono',
  'roboto mono',
  'ubuntu mono',
  'dejavu sans mono',
  'liberation mono',
  'noto sans mono',
  'hack',
  'inconsolata',
  'menlo',
  'monaco',
  'sf mono',
  'sarasa mono',
  'sarasa mono sc',
  'sarasa mono tc',
  'sarasa mono hc',
  'sarasa mono j',
  'sarasa mono k',
  'iosevka',
  'iosevka term',
])

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

function bareFontName(part: string): string {
  return part.replace(/^["']|["']$/g, '').trim().toLowerCase()
}

/** Reject generic / proportional faces that break OpenCode-style TUIs in WebView2. */
function isUsableTerminalFontPart(part: string): boolean {
  const bare = bareFontName(part)
  if (!bare || bare === 'ui-monospace' || bare === 'monospace' || bare === 'serif' || bare === 'sans-serif') {
    return false
  }
  if (SAFE_TERMINAL_FONT_NAMES.has(bare)) return true
  // Allow unknown families that still measure as monospace (W ≈ i).
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.font = `14px ${part}`
    const w = ctx.measureText('MW').width
    const n = ctx.measureText('ii').width
    return Math.abs(w - n) < 0.75
  } catch {
    return false
  }
}

/**
 * Font stack for xterm. Generic families like `ui-monospace` can resolve to a face
 * with poor box-drawing coverage while fallbacks supply glyphs at wrong widths,
 * which corrupts TUI UIs (block art, progress bars). Prefer concrete mono fonts.
 */
export function getResolvedTerminalFont(): string {
  const mono = getResolvedMonoFont()
  const parts = mono
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(isUsableTerminalFontPart)

  const seen = new Set<string>()
  const ordered: string[] = []
  for (const part of [...parts, ...TERMINAL_MONO_FONT.split(',').map(p => p.trim())]) {
    const key = bareFontName(part)
    if (!key || seen.has(key)) continue
    seen.add(key)
    ordered.push(part)
  }
  ordered.push('monospace')
  return ordered.join(', ')
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

const FONT_STYLE_SUFFIXES = [
  ' Bold Italic',
  ' Bold Oblique',
  ' SemiBold Italic',
  ' Semibold Italic',
  ' SemiLight Italic',
  ' Semilight Italic',
  ' ExtraBold Italic',
  ' ExtraLight Italic',
  ' Italic',
  ' Oblique',
  ' Bold',
  ' Light',
  ' Medium',
  ' SemiBold',
  ' Semibold',
  ' SemiLight',
  ' Semilight',
  ' Regular',
  ' Black',
  ' Thin',
  ' ExtraBold',
  ' ExtraLight',
  ' DemiBold',
  ' Heavy',
  ' Condensed',
  ' Narrow',
] as const

/** Strip weight/style suffixes so Bold/Semilight map to one family. */
export function normalizeFontFamilyLabel(raw: string): string | null {
  let family = raw.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (!family || family.includes('&')) return null
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of FONT_STYLE_SUFFIXES) {
      if (family.endsWith(suffix)) {
        const next = family.slice(0, -suffix.length).trimEnd()
        if (next) {
          family = next
          changed = true
          break
        }
      }
    }
  }
  return family || null
}

/** Split Windows TTC registry blobs (`A & B & C`) into individual family names. */
export function expandSystemFontFamilies(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    for (const part of name.split(/\s*&\s*/)) {
      const family = normalizeFontFamilyLabel(part)
      if (!family) continue
      const key = family.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(family)
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
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

export type FontKind = 'sans' | 'mono'

/** Build a CSS font-family stack from an OS font family name. */
export function fontStackFromFamily(family: string, kind: FontKind): string {
  const trimmed = family.trim()
  if (!trimmed) {
    return kind === 'mono' ? SYSTEM_MONO_FONT : SYSTEM_INTERFACE_FONT
  }
  const quoted = `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return kind === 'mono' ? `${quoted}, ${SYSTEM_MONO_FONT}` : `${quoted}, ${SYSTEM_INTERFACE_FONT}`
}

/** Turn installed family names into selectable options, skipping preset labels. */
export function systemFontOptions(
  families: string[],
  kind: FontKind,
  presetLabels: Iterable<string> = [],
): FontOption[] {
  const skip = new Set(
    [...presetLabels].map(label => label.trim().toLowerCase()).filter(Boolean),
  )
  return expandSystemFontFamilies(families)
    .filter(family => family && !skip.has(family.toLowerCase()))
    .map(family => ({
      label: family,
      value: fontStackFromFamily(family, kind),
    }))
}

let systemFontCache: string[] | null = null
let systemFontPending: Promise<string[]> | null = null

/** Load OS-installed font families once (empty outside Tauri / on failure). */
export async function loadSystemFontFamilies(): Promise<string[]> {
  if (systemFontCache) return systemFontCache
  if (!systemFontPending) {
    systemFontPending = (async () => {
      try {
        const { isTauri, safeInvoke } = await import('./tauri')
        if (!isTauri()) return []
        const fonts = await safeInvoke<string[]>('列出系统字体', 'list_system_fonts')
        return expandSystemFontFamilies(Array.isArray(fonts) ? fonts.filter(Boolean) : [])
      } catch {
        return []
      }
    })().then(fonts => {
      systemFontCache = fonts
      return fonts
    })
  }
  return systemFontPending
}
