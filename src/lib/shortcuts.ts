export type ShortcutCommand =
  | 'searchAllProjects'
  | 'toggleTerminal'
  | 'openSettings'
  | 'openCommandPalette'
  | 'quickOpen'
  | 'goToSymbolInEditor'
  | 'goToLine'

export type ShortcutMap = Record<ShortcutCommand, string>

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  searchAllProjects: 'Ctrl+Shift+F',
  toggleTerminal: 'Ctrl+`',
  openSettings: 'Ctrl+,',
  openCommandPalette: 'Ctrl+Shift+P',
  quickOpen: 'Ctrl+P',
  goToSymbolInEditor: 'Ctrl+Shift+O',
  goToLine: 'Ctrl+G',
}

export const RESERVED_SHORTCUTS = new Set([
  'Ctrl+S',
  'Ctrl+Shift+C',
  'Alt+C',
  'Shift+Alt+F',
  'Ctrl+Shift+I',
  'F12',
])

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

function normalizeKey(key: string): string | null {
  if (MODIFIER_KEYS.has(key) || key === 'Unidentified' || key === 'Dead') return null
  if (key === ' ') return 'Space'
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase()
  if (key.length === 1) return key.toUpperCase()
  if (key === 'Enter' || key === 'Escape' || key.startsWith('Arrow')) return key
  return null
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
  return [...parts, key].join('+')
}

export function shortcutMatchesEvent(shortcut: string, event: KeyboardEvent): boolean {
  return shortcutFromKeyboardEvent(event) === shortcut
}

export function isShortcutInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return false
  return Boolean(target.closest('input, textarea, select'))
}
