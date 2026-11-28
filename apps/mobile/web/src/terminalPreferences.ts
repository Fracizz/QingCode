const fontKey = 'qn.mobile.terminalFontSize'
const keysKey = 'qn.mobile.terminalQuickKeys'
export const DEFAULT_TERMINAL_FONT = 13
export const MIN_TERMINAL_FONT = 8
export const MAX_TERMINAL_FONT = 20

export function readTerminalFont(): number {
  try {
    const size = Number(localStorage.getItem(fontKey))
    if (Number.isInteger(size) && size >= MIN_TERMINAL_FONT && size <= MAX_TERMINAL_FONT) return size
  } catch { /* 存储不可用时使用默认字号。 */ }
  return DEFAULT_TERMINAL_FONT
}

export function saveTerminalFont(size: number): void {
  try { localStorage.setItem(fontKey, String(size)) } catch { /* 仍可在当前页面调整。 */ }
}

export function readTerminalQuickKeys(): string[] | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(keysKey) ?? 'null')
    if (Array.isArray(saved)) return saved.filter((key): key is string => typeof key === 'string')
  } catch { /* 存储不可用时使用默认快捷键。 */ }
  return null
}

export function saveTerminalQuickKeys(keys: readonly string[]): void {
  try { localStorage.setItem(keysKey, JSON.stringify(keys)) } catch { /* 当前页面仍保留修改。 */ }
}

export type TerminalPreferences = { selectedId?: string; names: Record<string, string> }

export function readTerminalPreferences(key: string): TerminalPreferences {
  try {
    const saved: TerminalPreferences | null = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (saved && typeof saved.names === 'object' && saved.names !== null && !Array.isArray(saved.names)) {
      const names = Object.fromEntries(Object.entries(saved.names).filter(([, name]) => typeof name === 'string'))
      return { selectedId: typeof saved.selectedId === 'string' ? saved.selectedId : undefined, names }
    }
  } catch { /* 旧数据或存储不可用时仍可使用终端。 */ }
  return { names: {} }
}

export function saveTerminalPreferences(key: string, prefs: TerminalPreferences): void {
  try { localStorage.setItem(key, JSON.stringify(prefs)) } catch { /* 当前页面仍保留修改。 */ }
}
