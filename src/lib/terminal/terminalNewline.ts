export const TERMINAL_NEWLINE_INPUT = '\n'

type TerminalNewlineKeyEvent = {
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Ctrl/Cmd+Enter sends LF (Ctrl+J) without the CR used to submit a line. */
export function isTerminalNewlineShortcut(event: TerminalNewlineKeyEvent): boolean {
  return (
    event.type === 'keydown' &&
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  )
}
