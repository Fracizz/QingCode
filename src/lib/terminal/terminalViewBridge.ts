/** UI actions targeted at the active TerminalView (clear buffer / open find). */

export const TERMINAL_CLEAR_EVENT = 'qingcode:terminal-clear'
export const TERMINAL_SEARCH_EVENT = 'qingcode:terminal-search'
export const TERMINAL_COPY_SCREEN_EVENT = 'qingcode:terminal-copy-screen'
export const TERMINAL_EXPORT_EVENT = 'qingcode:terminal-export'
export const TERMINAL_CLEAR_INPUT_EVENT = 'qingcode:terminal-clear-input'

export type TerminalViewBridgeDetail = {
  /** When set, only that terminal reacts; otherwise the active view reacts. */
  terminalId?: string
}

export function requestTerminalClear(terminalId?: string) {
  window.dispatchEvent(
    new CustomEvent<TerminalViewBridgeDetail>(TERMINAL_CLEAR_EVENT, {
      detail: { terminalId },
    }),
  )
}

export function requestTerminalSearch(terminalId?: string) {
  window.dispatchEvent(
    new CustomEvent<TerminalViewBridgeDetail>(TERMINAL_SEARCH_EVENT, {
      detail: { terminalId },
    }),
  )
}

/** 清除当前终端提示符 / AI CLI 输入框里尚未提交的内容（见 terminalClearInput.ts）。 */
export function requestTerminalClearInput(terminalId?: string) {
  window.dispatchEvent(
    new CustomEvent<TerminalViewBridgeDetail>(TERMINAL_CLEAR_INPUT_EVENT, {
      detail: { terminalId },
    }),
  )
}

/** 复制当前屏幕（原右键菜单项，现走命令面板）。 */
export function requestTerminalCopyScreen(terminalId?: string) {
  window.dispatchEvent(
    new CustomEvent<TerminalViewBridgeDetail>(TERMINAL_COPY_SCREEN_EVENT, {
      detail: { terminalId },
    }),
  )
}

export function requestTerminalExport(terminalId?: string) {
  window.dispatchEvent(
    new CustomEvent<TerminalViewBridgeDetail>(TERMINAL_EXPORT_EVENT, {
      detail: { terminalId },
    }),
  )
}
