/** Vite dev / `pnpm tauri:dev`; aligns with Rust `is_dev_build` and `.devtools(true)`. */
export function isFrontendDevBuild(): boolean {
  return import.meta.env.DEV
}

/** Dev-only: after F12 / devtools shortcuts, right-click uses WebView native menu. */
let preferNativeContextMenuInDev = false

export function isNativeContextMenuPreferredInDev(): boolean {
  return isFrontendDevBuild() && preferNativeContextMenuInDev
}

/** @internal test hook */
export function setNativeContextMenuPreferredInDev(preferred: boolean): void {
  preferNativeContextMenuInDev = preferred
}

export function deferToNativeContextMenuInDev(): boolean {
  return isNativeContextMenuPreferredInDev()
}

/** Show QingCode context menu unless dev has toggled native menu via devtools shortcuts. */
export function shouldShowAppContextMenu(event: {
  preventDefault(): void
  stopPropagation(): void
}): boolean {
  if (deferToNativeContextMenuInDev()) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

function isDevtoolsShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  if (key === 'f12') return true
  const windowsDevtools =
    event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
  const macDevtools = event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
  return ['c', 'i', 'j'].includes(key) && (windowsDevtools || macDevtools)
}

let devtoolsToggleInstalled = false

/** Toggle native context menu mode when opening/closing WebView devtools (dev only). */
export function installDevNativeContextMenuToggle() {
  if (!isFrontendDevBuild() || devtoolsToggleInstalled || typeof document === 'undefined') {
    return
  }
  devtoolsToggleInstalled = true

  document.addEventListener(
    'keydown',
    event => {
      if (!isDevtoolsShortcut(event)) return
      preferNativeContextMenuInDev = !preferNativeContextMenuInDev
    },
    true,
  )
}
