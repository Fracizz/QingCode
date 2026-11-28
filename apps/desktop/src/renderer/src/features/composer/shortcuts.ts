import { create } from 'zustand'

export type ComposerShortcut = {
  id: string
  name: string
  text: string
  send: boolean
}

const STORAGE_KEY = 'qn-composer-shortcuts'

function readShortcuts(): ComposerShortcut[] {
  if (typeof window === 'undefined') return []
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    const seen = new Set<string>()
    const shortcuts: ComposerShortcut[] = []
    for (const item of stored as unknown[]) {
      if (!item || typeof item !== 'object') continue
      const { id, name, text, send } = item as Partial<ComposerShortcut>
      if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string' || !name.trim() ||
        typeof text !== 'string' || !text.trim()) continue
      seen.add(id)
      shortcuts.push({ id, name: name.trim(), text, send: send === true })
    }
    return shortcuts
  } catch {
    return []
  }
}

export const useComposerShortcuts = create<{
  shortcuts: ComposerShortcut[]
  updateShortcuts: (update: (current: ComposerShortcut[]) => ComposerShortcut[]) => boolean
}>((set, get) => ({
  shortcuts: readShortcuts(),
  updateShortcuts: (update) => {
    const current = get().shortcuts
    const shortcuts = update(current)
    if (shortcuts === current) return true
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts))
    } catch {
      return false
    }
    set({ shortcuts })
    return true
  },
}))
