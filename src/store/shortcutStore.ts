import { create } from 'zustand'
import { DEFAULT_SHORTCUTS, type ShortcutCommand, type ShortcutMap } from '../lib/shortcuts'

const STORAGE_KEY = 'qingcode:shortcuts'

function loadShortcuts(): ShortcutMap {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ShortcutMap>
    return {
      searchAllProjects: typeof saved.searchAllProjects === 'string' ? saved.searchAllProjects : DEFAULT_SHORTCUTS.searchAllProjects,
      toggleTerminal: typeof saved.toggleTerminal === 'string' ? saved.toggleTerminal : DEFAULT_SHORTCUTS.toggleTerminal,
      openSettings: typeof saved.openSettings === 'string' ? saved.openSettings : DEFAULT_SHORTCUTS.openSettings,
    }
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
