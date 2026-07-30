import { useEffect, type RefObject } from 'react'
import { resetCaptionRegionCache, syncCaptionRegions } from '../lib/captionRegions'
import { isTauri } from '../lib/tauri'

/**
 * Keeps the window's native drag regions in sync with the `data-caption-region`
 * elements inside `rootRef`. See `src/lib/captionRegions.ts`.
 */
export function useCaptionRegions(rootRef: RefObject<HTMLElement | null>): void {
  // Title-bar layout shifts with project chips, panel-layout mode and locale, so
  // re-measure after every render rather than tracking each input. Sync calls are
  // coalesced into one frame and skipped when the rectangles are unchanged.
  useEffect(() => {
    syncCaptionRegions()
  })

  useEffect(() => {
    if (!isTauri()) return
    const root = rootRef.current
    if (!root) return

    const observer = new ResizeObserver(() => syncCaptionRegions())
    observer.observe(root)
    // Webfont swaps change the width of the labels inside the title bar.
    void document.fonts?.ready.then(() => syncCaptionRegions()).catch(() => {})

    return () => observer.disconnect()
  }, [rootRef])

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined

    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onScaleChanged(() => {
          // CSS rectangles can be identical across a DPI change while the
          // physical pixels the backend derives from them move.
          resetCaptionRegionCache()
          syncCaptionRegions()
        })
      )
      .then(fn => {
        unlisten = fn
      })
      .catch(() => {})

    return () => unlisten?.()
  }, [])
}
