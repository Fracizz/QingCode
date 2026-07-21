import { isFrontendDevBuild } from './devBuild'

export type ContextMenuGuardOptions = {
  /** Dev builds may use the WebView native context menu (inspect, copy, etc.). */
  allowNativeContextMenu?: boolean
}

function resolveAllowNativeContextMenu(options?: ContextMenuGuardOptions): boolean {
  return options?.allowNativeContextMenu ?? isFrontendDevBuild()
}

/** Selectors that keep the browser/WebView native context menu (copy, paste, etc.). */
const NATIVE_MENU_SELECTOR = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="image"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[data-native-context-menu]',
  // Terminal (.xterm) uses a custom ContextMenu — native WebView menus add browser chrome.
].join(', ')

/** App surfaces that use custom menus or should never show the browser menu. */
const BLOCK_NATIVE_SELECTOR = '.cm-editor, [data-block-native-context-menu]'

function allowsNativeContextMenu(target: EventTarget | null): boolean {
  if (target == null || typeof Element === 'undefined' || !(target instanceof Element)) {
    return false
  }
  if (target.closest(BLOCK_NATIVE_SELECTOR)) return false

  const host = target.closest(NATIVE_MENU_SELECTOR)
  if (!host) return false

  if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement || host instanceof HTMLSelectElement) {
    return !host.disabled
  }

  return true
}

/** Whether prod should cancel the WebView default context menu for this target. */
export function shouldPreventNativeContextMenu(
  target: EventTarget | null,
  options?: ContextMenuGuardOptions,
): boolean {
  if (resolveAllowNativeContextMenu(options)) return false
  return !allowsNativeContextMenu(target)
}

let installed = false

/** Block WebView native context menus except on text-editing controls. */
export function installContextMenuGuard(options?: ContextMenuGuardOptions) {
  if (installed || typeof document === 'undefined') return
  installed = true

  const allowNative = resolveAllowNativeContextMenu(options)
  if (allowNative) return

  document.addEventListener(
    'contextmenu',
    event => {
      if (shouldPreventNativeContextMenu(event.target)) {
        event.preventDefault()
      }
    },
    true,
  )
}
