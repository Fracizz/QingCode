import { create } from 'zustand'
import {
  defaultShortcutBarState,
  moveShortcutKey,
  parseShortcutBarState,
  reorderShortcutKey,
  removeCustomKey,
  saveCustomKey,
  serializeShortcutBarState,
  toggleShortcutKeyHidden,
  type TerminalShortcutBarState,
} from '@/lib/terminal/terminalShortcutBar'

/** 终端快捷键栏布局与折叠状态（本机偏好，随「导出配置」导出）。 */
export const TERMINAL_SHORTCUT_BAR_KEY = 'qingcode:terminal-shortcut-bar'

function load(): TerminalShortcutBarState {
  try {
    return parseShortcutBarState(localStorage.getItem(TERMINAL_SHORTCUT_BAR_KEY))
  } catch {
    return defaultShortcutBarState()
  }
}

function persist(state: TerminalShortcutBarState) {
  try {
    if (!state.collapsed && !state.custom.length) {
      localStorage.removeItem(TERMINAL_SHORTCUT_BAR_KEY)
    } else {
      localStorage.setItem(TERMINAL_SHORTCUT_BAR_KEY, serializeShortcutBarState(state))
    }
  } catch {
    // 只是显示偏好：保存失败时本次仍然生效。
  }
}

function pick(state: TerminalShortcutBarState): TerminalShortcutBarState {
  return { order: state.order, hidden: state.hidden, custom: state.custom, collapsed: state.collapsed }
}

type Store = TerminalShortcutBarState & {
  /** 管理弹窗是否打开（不持久化）。 */
  managerOpen: boolean
  openManager: () => void
  closeManager: () => void
  setCollapsed: (collapsed: boolean) => void
  toggleCollapsed: () => void
  toggleHidden: (key: string) => void
  move: (key: string, delta: number) => void
  reorder: (source: string, target: string, position: 'before' | 'after') => void
  saveCustomKey: (raw: unknown) => void
  removeCustomKey: (id: string) => void
  /** 整体替换（导入配置 / 恢复默认配置 / 其他窗口同步）。 */
  replace: (raw: unknown) => void
}

export const useTerminalShortcutBarStore = create<Store>((set, get) => {
  const update = (next: TerminalShortcutBarState) => {
    const state = pick(next)
    persist(state)
    set(state)
  }
  return {
    ...load(),
    managerOpen: false,
    openManager: () => set({ managerOpen: true }),
    closeManager: () => set({ managerOpen: false }),
    setCollapsed: collapsed => update({ ...pick(get()), collapsed }),
    toggleCollapsed: () => update({ ...pick(get()), collapsed: !get().collapsed }),
    toggleHidden: key => update(toggleShortcutKeyHidden(pick(get()), key)),
    move: (key, delta) => update(moveShortcutKey(pick(get()), key, delta)),
    reorder: (source, target, position) => update(reorderShortcutKey(pick(get()), source, target, position)),
    saveCustomKey: raw => update(saveCustomKey(pick(get()), raw)),
    removeCustomKey: id => update(removeCustomKey(pick(get()), id)),
    replace: raw => update(parseShortcutBarState(raw)),
  }
})

export function currentShortcutBarState(): TerminalShortcutBarState {
  return pick(useTerminalShortcutBarStore.getState())
}

/** 多窗口：其他窗口修改后同步过来（不回写，避免互相覆盖）。 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== TERMINAL_SHORTCUT_BAR_KEY) return
    useTerminalShortcutBarStore.setState(load())
  })
}
