import { create } from 'zustand'
import { clampSidebarWidth, parseLayoutPrefs, type ChatWidth, type LayoutPrefs } from '../lib/layout'

const LAYOUT_KEY = 'qn-layout'

type UiState = LayoutPrefs & {
  /** "添加项目"目录选择器：侧栏与欢迎页都能打开，所以放全局。 */
  directoryPickerOpen: boolean
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  setChatWidth: (width: ChatWidth) => void
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

const saveLayout = ({ sidebarWidth, sidebarCollapsed, chatWidth }: LayoutPrefs): void => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth, sidebarCollapsed, chatWidth }))
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
    saveLayout(get())
  },

  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed })
    saveLayout(get())
  },

  setChatWidth: (chatWidth) => {
    set({ chatWidth })
    saveLayout(get())
  },

  openDirectoryPicker: () => set({ directoryPickerOpen: true }),
  closeDirectoryPicker: () => set({ directoryPickerOpen: false }),
}))
