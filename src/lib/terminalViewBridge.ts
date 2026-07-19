/** UI actions targeted at the active TerminalView (clear buffer / open find). */

export const TERMINAL_CLEAR_EVENT = 'qingcode:terminal-clear'
export const TERMINAL_SEARCH_EVENT = 'qingcode:terminal-search'

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
