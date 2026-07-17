import { isTauri } from './tauri'

let revealScheduled = false

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const MIN_SANE_WIDTH = 200
const MIN_SANE_HEIGHT = 200

/**
 * Fallback reveal when the HTML splash script did not show the window,
 * or the native window is still stuck at the ~14x14 borderless boot size.
 */
export function revealAppWindow() {
  if (!isTauri() || revealScheduled) return
  revealScheduled = true
  void import('@tauri-apps/api/window').then(async ({ getCurrentWindow, LogicalSize }) => {
    const win = getCurrentWindow()
    try {
      const visible = await win.isVisible()
      const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()])
      const logicalW = size.width / scale
      const logicalH = size.height / scale
      const needsRepair = logicalW < MIN_SANE_WIDTH || logicalH < MIN_SANE_HEIGHT

      if (needsRepair) {
        // Prefer repairing while hidden to avoid title-bar flash.
        if (visible) {
          try {
            await win.hide()
          } catch {
            // continue with best-effort resize
          }
        }
        try {
          await win.setDecorations(true)
        } catch {
          // optional permission
        }
        await win.setSize(new LogicalSize(DEFAULT_WIDTH, DEFAULT_HEIGHT))
        try {
          await win.setDecorations(false)
        } catch {
          // keep default chrome if toggle fails
        }
        await win.center()
      }

      if (!visible || needsRepair) {
        await win.show()
      }
    } catch {
      try {
        await win.show()
      } catch {
        // ignore
      }
    }
  })
}
