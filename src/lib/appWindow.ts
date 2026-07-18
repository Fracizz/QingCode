import { isTauri, NotInTauriError } from './tauri'

let revealScheduled = false

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
const MIN_SANE_WIDTH = 200
const MIN_SANE_HEIGHT = 200

/** Open another QingCode window with a clean workspace (no inherited project/tabs). */
export async function openNewAppWindow() {
  if (!isTauri()) throw new NotInTauriError('新建窗口')
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const label = `qing-${Date.now()}`
  await new Promise<void>((resolve, reject) => {
    const win = new WebviewWindow(label, {
      // `fresh=1` → sessionStorage flag; skip auto-restoring last project.
      url: '/?fresh=1',
      title: 'QingCode',
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      minWidth: 720,
      minHeight: 480,
      decorations: false,
      center: true,
      visible: false,
      backgroundColor: '#1e1e1e',
    })
    void win.once('tauri://created', () => resolve())
    void win.once('tauri://error', event => {
      reject(new Error(String(event.payload ?? '新建窗口失败')))
    })
  })
}

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
        // Prefer repairing while hidden; avoid decorations toggles (blank WebView2).
        if (visible) {
          try {
            await win.hide()
          } catch {
            // continue with best-effort resize
          }
        }
        await win.setSize(new LogicalSize(DEFAULT_WIDTH, DEFAULT_HEIGHT))
        await win.center()
        const [nextSize, nextScale] = await Promise.all([win.innerSize(), win.scaleFactor()])
        const nextW = nextSize.width / nextScale
        const nextH = nextSize.height / nextScale
        if (nextW < MIN_SANE_WIDTH || nextH < MIN_SANE_HEIGHT) {
          try {
            await win.setDecorations(true)
            await win.setSize(new LogicalSize(DEFAULT_WIDTH, DEFAULT_HEIGHT))
            await win.setDecorations(false)
            await win.setSize(new LogicalSize(DEFAULT_WIDTH, DEFAULT_HEIGHT))
            await win.center()
          } catch {
            // best-effort
          }
        }
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
