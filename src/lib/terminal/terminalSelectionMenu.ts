/** Explicit terminal selection wins; otherwise mouse-aware TUIs own the right-click. */
export function shouldUseTerminalContextMenu(
  hasSelection: boolean,
  mouseTrackingMode: string,
  shiftKey: boolean
): boolean {
  return hasSelection || mouseTrackingMode === 'none' || shiftKey
}

/** Keep selected/Shift right-clicks out of TUI mouse reporting (Claude, tmux, etc.). */
export function protectTerminalSelectionMenu(
  container: HTMLElement,
  getSelection: () => string,
  appMenuEnabled: () => boolean,
  openMenu: (event: MouseEvent, selection: string) => void
): () => void {
  let blockedRightClick = false
  let pressedSelection = ''
  const onMouseDown = (event: MouseEvent) => {
    pressedSelection = event.button === 2 ? getSelection() : ''
    blockedRightClick =
      event.button === 2 && (!!pressedSelection || event.shiftKey) && appMenuEnabled()
    if (!blockedRightClick) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 2 || !blockedRightClick) return
    blockedRightClick = false
    event.preventDefault()
    event.stopPropagation()
  }
  const onContextMenu = (event: MouseEvent) => {
    const selection = pressedSelection || getSelection()
    pressedSelection = ''
    if (!appMenuEnabled() || (!selection && !event.shiftKey)) return
    // Run before xterm's contextmenu handler focuses/selects its hidden textarea.
    // Keep the press-time text even if output cleared the selection before this event.
    event.preventDefault()
    event.stopPropagation()
    openMenu(event, selection)
  }
  const doc = container.ownerDocument
  container.addEventListener('mousedown', onMouseDown, true)
  container.addEventListener('contextmenu', onContextMenu, true)
  // xterm reports releases on document; suppress the matching release even outside the terminal.
  doc.addEventListener('mouseup', onMouseUp, true)
  return () => {
    container.removeEventListener('mousedown', onMouseDown, true)
    container.removeEventListener('contextmenu', onContextMenu, true)
    doc.removeEventListener('mouseup', onMouseUp, true)
  }
}
