let installed = false

function isBrowserReloadHotkey(event: KeyboardEvent): boolean {
  if (event.key === 'F5') return true
  // Ctrl/Cmd+R and Ctrl/Cmd+Shift+R — WebView2 page reload accelerators.
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
  return event.key.toLowerCase() === 'r'
}

/** Block WebView/browser reload accelerators (F5, Ctrl/Cmd+R). Programmatic reload still works. */
export function installBrowserReloadGuard() {
  if (installed || typeof document === 'undefined') return
  installed = true

  document.addEventListener(
    'keydown',
    event => {
      if (!isBrowserReloadHotkey(event)) return
      event.preventDefault()
    },
    true,
  )
}
