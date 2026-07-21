import { isFrontendDevBuild } from './devBuild'

const DEVTOOLS_KEYS = new Set(['c', 'i', 'j'])

export type WebviewShortcutGuardOptions = {
  /** Dev builds may open WebView devtools (F12, Ctrl+Shift+I/J/C, …). */
  allowDevtools?: boolean
}

function resolveAllowDevtools(options?: WebviewShortcutGuardOptions): boolean {
  return options?.allowDevtools ?? isFrontendDevBuild()
}

function isWebviewDevtoolsShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  if (key === 'f12') return true

  const windowsDevtools =
    event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
  const macDevtools =
    event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
  return DEVTOOLS_KEYS.has(key) && (windowsDevtools || macDevtools)
}

/** WebView accelerators that must not take over QingCode keyboard input. */
export function isWebviewNativeShortcut(
  event: KeyboardEvent,
  options?: WebviewShortcutGuardOptions,
): boolean {
  const key = event.key.toLowerCase()
  if (key === 'f5') return true

  const primaryModifier = event.ctrlKey || event.metaKey
  if (primaryModifier && !event.altKey && key === 'r') return true

  if (isWebviewDevtoolsShortcut(event)) {
    return !resolveAllowDevtools(options)
  }

  return false
}

export function preventWebviewNativeShortcut(
  event: KeyboardEvent,
  options?: WebviewShortcutGuardOptions,
): boolean {
  if (!isWebviewNativeShortcut(event, options)) return false
  event.preventDefault()
  return true
}

let installed = false

/** Cancel WebView defaults without stopping QingCode handlers for the same keystroke. */
export function installWebviewShortcutGuard(options?: WebviewShortcutGuardOptions) {
  if (installed || typeof document === 'undefined') return
  installed = true

  const allowDevtools = resolveAllowDevtools(options)

  document.addEventListener(
    'keydown',
    event => {
      preventWebviewNativeShortcut(event, { allowDevtools })
    },
    true,
  )
}
