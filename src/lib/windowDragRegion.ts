export type WindowDragRegionMode = 'none' | 'native' | 'tauri-fallback'

/** WebView2 123 introduced CSS `app-region` non-client regions. */
const NATIVE_DRAG_MIN_EDGE_MAJOR = 123

/**
 * Select exactly one window-drag path.
 *
 * Modern WebView2 should use the native non-client region exclusively so a
 * pointer press never waits for Tauri's JS `mousedown` + `start_dragging` IPC.
 * Older Windows runtimes and other desktop engines retain Tauri's fallback.
 */
export function resolveWindowDragRegionMode(
  inTauri: boolean,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): WindowDragRegionMode {
  if (!inTauri) return 'none'
  if (!/\bWindows\b/i.test(userAgent)) return 'tauri-fallback'

  const edgeMajor = Number(/\bEdg\/(\d+)/i.exec(userAgent)?.[1] ?? 0)
  return edgeMajor >= NATIVE_DRAG_MIN_EDGE_MAJOR ? 'native' : 'tauri-fallback'
}
