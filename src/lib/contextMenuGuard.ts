/** Selectors that keep the browser/WebView native context menu (copy, paste, etc.). */
const NATIVE_MENU_SELECTOR = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[data-native-context-menu]',
  // xterm focuses its hidden textarea on right-click for copy/paste via the WebView menu.
  '.xterm',
].join(', ')

/** App surfaces that use custom menus or should never show the browser menu. */
const BLOCK_NATIVE_SELECTOR = '.cm-editor, [data-block-native-context-menu]'

function allowsNativeContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(BLOCK_NATIVE_SELECTOR)) return false

  const host = target.closest(NATIVE_MENU_SELECTOR)
  if (!host) return false

  if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement || host instanceof HTMLSelectElement) {
    return !host.disabled
  }

  return true
}

let installed = false

/** Block WebView native context menus except on text-editing controls. */
export function installContextMenuGuard() {
  if (installed || typeof document === 'undefined') return
  installed = true

  document.addEventListener(
    'contextmenu',
    event => {
      if (allowsNativeContextMenu(event.target)) return
      event.preventDefault()
    },
    true,
  )
}
