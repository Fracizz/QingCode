export type ShortcutCommand =
  | 'searchAllProjects'
  | 'toggleTerminal'
  | 'openSettings'
  | 'openCommandPalette'
  | 'quickOpen'
  | 'goToSymbolInEditor'
  | 'goToLine'
  | 'toggleMinimap'
  | 'renameInExplorer'

export type ShortcutMap = Record<ShortcutCommand, string>

/** Empty string means unbound (disabled). */
export const DEFAULT_SHORTCUTS: ShortcutMap = {
  searchAllProjects: 'Ctrl+Shift+F',
  toggleTerminal: 'Ctrl+`',
  openSettings: 'Ctrl+,',
  openCommandPalette: 'Ctrl+Shift+P',
  quickOpen: 'Ctrl+P',
  goToSymbolInEditor: 'Ctrl+Shift+O',
  goToLine: 'Ctrl+G',
  toggleMinimap: 'Ctrl+Shift+G',
  renameInExplorer: 'F2',
}

export function isShortcutBound(shortcut: string): boolean {
  return shortcut.trim().length > 0
}

/** Display form (VS Code style). Matching uses canonicalizeShortcut. */
export const RESERVED_SHORTCUTS = new Set([
  'Ctrl+S',
  'Ctrl+Shift+C',
  'Alt+C',
  'Shift+Alt+F',
  'Ctrl+Shift+I',
  'F12',
])

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])
/** Canonical modifier order for compare / storage. */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

function normalizeKey(key: string): string | null {
  if (MODIFIER_KEYS.has(key) || key === 'Unidentified' || key === 'Dead') return null
  if (key === ' ') return 'Space'
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase()
  if (key.length === 1) return key.toUpperCase()
  if (key === 'Enter' || key === 'Escape' || key.startsWith('Arrow')) return key
  return null
}

/** Normalize `Shift+Alt+F` / `Alt+Shift+F` to the same string. */
export function canonicalizeShortcut(shortcut: string): string {
  const parts = shortcut.split('+').filter(Boolean)
  if (parts.length === 0) return shortcut
  const key = parts[parts.length - 1]
  const mods = new Set(
    parts.slice(0, -1).map(m => (m === 'Control' || m === 'Ctl' ? 'Ctrl' : m)),
  )
  return [...MODIFIER_ORDER.filter(m => mods.has(m)), key].join('+')
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = normalizeKey(event.key)
  if (!key) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  if (parts.length === 0 && !key.startsWith('F')) return null
  return canonicalizeShortcut([...parts, key].join('+'))
}

export function shortcutMatchesEvent(shortcut: string, event: KeyboardEvent): boolean {
  if (!isShortcutBound(shortcut)) return false
  const pressed = shortcutFromKeyboardEvent(event)
  if (!pressed) return false
  return pressed === canonicalizeShortcut(shortcut)
}

export function isReservedShortcut(shortcut: string): boolean {
  const canonical = canonicalizeShortcut(shortcut)
  for (const reserved of RESERVED_SHORTCUTS) {
    if (canonicalizeShortcut(reserved) === canonical) return true
  }
  return false
}

export function isShortcutInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return false
  return Boolean(target.closest('input, textarea, select'))
}
