/** Keep a right-click on selected text out of TUI mouse reporting (Claude, tmux, etc.). */
export function protectTerminalSelectionMenu(
  container: HTMLElement,
  hasSelection: () => boolean,
  appMenuEnabled: () => boolean,
): () => void {
  let blockedRightClick = false
  const onMouseDown = (event: MouseEvent) => {
    blockedRightClick = event.button === 2 && hasSelection() && appMenuEnabled()
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
  const doc = container.ownerDocument
  container.addEventListener('mousedown', onMouseDown, true)
  // xterm reports releases on document; suppress the matching release even outside the terminal.
  doc.addEventListener('mouseup', onMouseUp, true)
  return () => {
    container.removeEventListener('mousedown', onMouseDown, true)
    doc.removeEventListener('mouseup', onMouseUp, true)
  }
}
