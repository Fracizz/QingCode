const DEVTOOLS_KEYS = new Set(['c', 'i', 'j'])

/** WebView accelerators that must not take over QingCode keyboard input. */
export function isWebviewNativeShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  if (key === 'f5' || key === 'f12') return true

  const primaryModifier = event.ctrlKey || event.metaKey
  if (primaryModifier && !event.altKey && key === 'r') return true

  const windowsDevtools =
    event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
  const macDevtools =
    event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
  return DEVTOOLS_KEYS.has(key) && (windowsDevtools || macDevtools)
}

export function preventWebviewNativeShortcut(event: KeyboardEvent): boolean {
  if (!isWebviewNativeShortcut(event)) return false
  event.preventDefault()
  return true
}

let installed = false

/** Cancel WebView defaults without stopping QingCode handlers for the same keystroke. */
export function installWebviewShortcutGuard() {
  if (installed || typeof document === 'undefined') return
  installed = true

  document.addEventListener(
    'keydown',
    event => {
      preventWebviewNativeShortcut(event)
    },
    true,
  )
}
