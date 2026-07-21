/** Vite dev / `pnpm tauri:dev`; aligns with Rust `is_dev_build` and `.devtools(true)`. */
export function isFrontendDevBuild(): boolean {
  return import.meta.env.DEV
}

/** Let WebView show its native context menu (Inspect, etc.) instead of QingCode menus. */
export function deferToNativeContextMenuInDev(): boolean {
  return isFrontendDevBuild()
}

/** Cancel default and stop propagation when QingCode should show its own context menu. */
export function shouldShowAppContextMenu(event: {
  preventDefault(): void
  stopPropagation(): void
}): boolean {
  if (deferToNativeContextMenuInDev()) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}
