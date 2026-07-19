import { create } from 'zustand'
import { DEFAULT_SHORTCUTS, type ShortcutCommand, type ShortcutMap } from '../lib/shortcuts'

const STORAGE_KEY = 'qingcode:shortcuts'

function loadShortcuts(): ShortcutMap {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ShortcutMap>
    const shortcuts = { ...DEFAULT_SHORTCUTS }
    for (const key of Object.keys(DEFAULT_SHORTCUTS) as ShortcutCommand[]) {
      // Empty string is a valid unbound override; only fall back when missing/non-string.
      if (typeof saved[key] === 'string') shortcuts[key] = saved[key]!
    }
    return shortcuts
  } catch {
    return { ...DEFAULT_SHORTCUTS }
  }
}

function persist(shortcuts: ShortcutMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts))
  } catch {}
}

type ShortcutState = {
  shortcuts: ShortcutMap
  setShortcut: (command: ShortcutCommand, shortcut: string) => void
  resetShortcuts: () => void
}

export const useShortcutStore = create<ShortcutState>(set => ({
  shortcuts: loadShortcuts(),
  setShortcut: (command, shortcut) =>
    set(state => {
      const shortcuts = { ...state.shortcuts, [command]: shortcut }
      persist(shortcuts)
      return { shortcuts }
    }),
  resetShortcuts: () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS }
    persist(shortcuts)
    set({ shortcuts })
  },
}))
