import { isTauri, safeInvoke } from './tauri'

/**
 * Native title-bar drag regions.
 *
 * Elements marked with `data-caption-region` are reported to the Rust side, which
 * answers `WM_NCHITTEST` with `HTCAPTION` for them so Windows starts the window
 * move itself. Without this, dragging depends on a JS `mousedown` plus an IPC
 * round trip and stalls whenever the webview's main thread is busy — see
 * `src-tauri/src/native_caption.rs`.
 *
 * Only mark inert chrome: inside a caption rectangle the webview receives no
 * mouse events at all, so hover, click and context menus would stop working.
 */
const CAPTION_REGION_ATTR = 'data-caption-region'

interface CaptionRegion {
  x: number
  y: number
  width: number
  height: number
}

/** Sub-pixel jitter must not turn into a stream of IPC calls. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

function collectRegions(): CaptionRegion[] {
  const nodes = document.querySelectorAll<HTMLElement>(`[${CAPTION_REGION_ATTR}]`)
  const regions: CaptionRegion[] = []
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    // Collapsed flex fillers are common and carry no draggable area.
    if (rect.width < 1 || rect.height < 1) continue
    regions.push({
      x: round(rect.left),
      y: round(rect.top),
      width: round(rect.width),
      height: round(rect.height),
    })
  }
  return regions
}

let frame = 0
let lastSent = ''

/**
 * Pushes the current drag regions to the window, coalesced into one frame and
 * skipped when nothing moved.
 */
export function syncCaptionRegions(): void {
  if (!isTauri() || frame !== 0) return
  frame = window.requestAnimationFrame(() => {
    frame = 0
    const regions = collectRegions()
    const payload = JSON.stringify(regions)
    if (payload === lastSent) return
    lastSent = payload
    void safeInvoke('设置窗口拖动区域', 'set_caption_regions', { regions }).catch(() => {
      // Let the next sync retry; `data-tauri-drag-region` still covers dragging.
      lastSent = ''
    })
  })
}

/** Drops the cached payload so the next sync always reaches the backend. */
export function resetCaptionRegionCache(): void {
  lastSent = ''
}
