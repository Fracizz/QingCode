import { create } from 'zustand'
import { parseRecent, pushRecent } from './paletteModel'

// 面板开关与最近使用记录。全局单例，快捷键、菜单、其它组件都可调用 openCommandPalette。

const RECENT_KEY = 'qn-palette-recent'

export type CommandPaletteState = {
  open: boolean
  /** 打开时预填的输入，如 '>'；每次打开都会重置 */
  initialQuery: string
  /** 面板内错误行：命令执行失败且宿主未提供 onError 时显示 */
  error: string | null
  recent: string[]
  openPalette: (initialQuery?: string) => void
  closePalette: () => void
  togglePalette: () => void
  showError: (message: string) => void
  clearError: () => void
  markUsed: (id: string) => void
}

const readRecent = (): string[] => {
  try {
    return parseRecent(typeof localStorage === 'undefined' ? null : localStorage.getItem(RECENT_KEY))
  } catch {
    return []
  }
}

const saveRecent = (recent: readonly string[]): void => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    // 存储不可用时只是不记最近使用。
  }
}

export const useCommandPalette = create<CommandPaletteState>((set, get) => ({
  open: false,
  initialQuery: '',
  error: null,
  recent: readRecent(),
  openPalette: (initialQuery = '') => set({ open: true, initialQuery, error: null }),
  closePalette: () => set({ open: false }),
  togglePalette: () => (get().open ? set({ open: false }) : set({ open: true, initialQuery: '', error: null })),
  // 失败时重新打开面板，让用户看到错误并可直接重试或换个命令
  showError: (message) => set({ open: true, initialQuery: '', error: message }),
  clearError: () => set({ error: null }),
  markUsed: (id) => {
    const recent = pushRecent(get().recent, id)
    set({ recent })
    saveRecent(recent)
  },
}))

export function openCommandPalette(initialQuery?: string): void {
  useCommandPalette.getState().openPalette(initialQuery)
}

export function closeCommandPalette(): void {
  useCommandPalette.getState().closePalette()
}

export function toggleCommandPalette(): void {
  useCommandPalette.getState().togglePalette()
}
