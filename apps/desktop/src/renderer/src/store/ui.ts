import { create } from 'zustand'
import { clampSidebarWidth, parseLayoutPrefs, type LayoutPrefs } from '../lib/layout'

const LAYOUT_KEY = 'qn-layout'

type UiState = LayoutPrefs & {
  /** "添加项目"目录选择器：侧栏与欢迎页都能打开，所以放全局。 */
  directoryPickerOpen: boolean
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  openDirectoryPicker: () => void
  closeDirectoryPicker: () => void
}

const readLayout = (): LayoutPrefs => {
  try {
    return parseLayoutPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(LAYOUT_KEY))
  } catch {
    return parseLayoutPrefs(null)
  }
}

const saveLayout = (prefs: LayoutPrefs): void => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(prefs))
  } catch {
    // 存储不可用时只影响下次启动的布局记忆。
  }
}

export const useUi = create<UiState>((set, get) => ({
  ...readLayout(),
  directoryPickerOpen: false,

  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width, typeof window === 'undefined' ? undefined : window.innerWidth)
    set({ sidebarWidth })
    saveLayout({ sidebarWidth, sidebarCollapsed: get().sidebarCollapsed })
  },

  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed })
    saveLayout({ sidebarWidth: get().sidebarWidth, sidebarCollapsed })
  },

  openDirectoryPicker: () => set({ directoryPickerOpen: true }),
  closeDirectoryPicker: () => set({ directoryPickerOpen: false }),
}))
