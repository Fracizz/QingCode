import { create } from 'zustand'
import { clampSidebarWidth, parseLayoutPrefs, type ChatWidth, type LayoutPrefs } from '../lib/layout'

const LAYOUT_KEY = 'qn-layout'

export type ThreadListReveal = { targetId: string; projectId: string; threadKey: string | null }

type UiState = LayoutPrefs & {
  /** "添加项目"目录选择器：侧栏与欢迎页都能打开，所以放全局。 */
  directoryPickerOpen: boolean
  /** 目录选择器要把项目加到哪个目标；为空时用当前活动目标。 */
  directoryPickerTarget: string | null
  threadListReveal: ThreadListReveal | null
  setSidebarWidth: (width: number) => void
  toggleSidebar: () => void
  revealThreadList: (request: ThreadListReveal) => void
  finishThreadListReveal: (request: ThreadListReveal) => void
  setChatWidth: (width: ChatWidth) => void
  openDirectoryPicker: (targetId?: string) => void
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
  directoryPickerTarget: null,
  threadListReveal: null,

  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width, typeof window === 'undefined' ? undefined : window.innerWidth)
    set({ sidebarWidth })
    saveLayout(get())
  },

  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed, threadListReveal: null })
    saveLayout(get())
  },

  revealThreadList: (threadListReveal) => {
    const wasCollapsed = get().sidebarCollapsed
    set({ sidebarCollapsed: false, threadListReveal })
    if (wasCollapsed) saveLayout(get())
  },

  finishThreadListReveal: (request) => {
    if (get().threadListReveal === request) set({ threadListReveal: null })
  },

  setChatWidth: (chatWidth) => {
    set({ chatWidth })
    saveLayout(get())
  },

  openDirectoryPicker: (targetId) => set({ directoryPickerOpen: true, directoryPickerTarget: targetId ?? null }),
  closeDirectoryPicker: () => set({ directoryPickerOpen: false, directoryPickerTarget: null }),
}))
