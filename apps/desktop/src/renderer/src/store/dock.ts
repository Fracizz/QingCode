import { create } from 'zustand'

// 右侧工作区停靠栏：工具列（资源管理器 / 搜索 / Git）+ 文件查看面板（features/files 自管 open）。

export type DockTool = 'explorer' | 'search' | 'git' | 'run'
type DockView = 'chat' | 'files'

export type DockPrefs = {
  tool: DockTool | null
  /** 文件面板宽度 */
  filesWidth: number
  /** 工具列宽度 */
  toolWidth: number
}

const KEY = 'qn-dock'
export const FILES_MIN = 320
export const FILES_MAX = 1400
export const TOOL_MIN = 200
export const TOOL_MAX = 560
export const DEFAULT_DOCK: DockPrefs = { tool: null, filesWidth: 560, toolWidth: 280 }

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback

export function parseDockPrefs(raw: string | null | undefined): DockPrefs {
  if (!raw) return DEFAULT_DOCK
  try {
    const x = JSON.parse(raw) as Record<string, unknown>
    const tool = x.tool === 'explorer' || x.tool === 'search' || x.tool === 'git' || x.tool === 'run' ? x.tool : null
    return {
      tool,
      filesWidth: clamp(x.filesWidth, FILES_MIN, FILES_MAX, DEFAULT_DOCK.filesWidth),
      toolWidth: clamp(x.toolWidth, TOOL_MIN, TOOL_MAX, DEFAULT_DOCK.toolWidth),
    }
  } catch {
    return DEFAULT_DOCK
  }
}

type DockState = DockPrefs & {
  view: DockView | null
  fileTool: 'explorer' | 'search'
  setView: (view: DockView) => void
  toggleView: (view: DockView) => void
  /** 再次点击当前工具即收起 */
  toggleTool: (tool: DockTool) => void
  showTool: (tool: DockTool) => void
  hideTool: () => void
  setFilesWidth: (width: number) => void
  setToolWidth: (width: number) => void
}

const read = (): DockPrefs => {
  try {
    return parseDockPrefs(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_DOCK
  }
}

const persist = (prefs: DockPrefs): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // 存储不可用时只影响下次启动的布局。
  }
}

export const useDock = create<DockState>((set, get) => {
  const update = (patch: Partial<DockPrefs & { view: DockView }>): void => {
    set(patch)
    const { tool, filesWidth, toolWidth } = get()
    persist({ tool, filesWidth, toolWidth })
  }
  return {
    ...read(),
    view: 'chat',
    fileTool: 'explorer',
    setView: (view) => set({ view }),
    toggleView: (view) => set((state) => ({ view: state.view === view ? null : view })),
    toggleTool: (tool) => {
      const { view, tool: currentTool } = get()
      if (view === 'files' && (tool === 'explorer' || tool === 'search')) {
        set({ fileTool: tool })
        return
      }
      update({ view: 'chat', tool: view === 'chat' && currentTool === tool ? null : tool })
    },
    showTool: (tool) => update({ tool }),
    hideTool: () => update({ tool: null }),
    setFilesWidth: (width) => update({ filesWidth: clamp(width, FILES_MIN, FILES_MAX, DEFAULT_DOCK.filesWidth) }),
    setToolWidth: (width) => update({ toolWidth: clamp(width, TOOL_MIN, TOOL_MAX, DEFAULT_DOCK.toolWidth) }),
  }
})
