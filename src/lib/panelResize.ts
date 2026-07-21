const RESIZING_CLASS = 'panel-resizing'
const SNAPSHOT_HOST_CLASS = 'terminal-resize-snapshot-host'
const SNAPSHOT_CLASS = 'terminal-resize-snapshot'

export const PANEL_RESIZE_RENDER_TIMEOUT_MS = 400

export type PanelResizeOrientation = 'horizontal' | 'vertical'

export interface PanelResizeSettleDetail {
  readonly orientation: PanelResizeOrientation
  /** Must be called synchronously by settle listeners. */
  waitUntil(readiness: PromiseLike<unknown>): void
}

interface FrozenTerminalSurface {
  surface: HTMLElement
  host: HTMLElement
  snapshot: HTMLCanvasElement
  addedHostClass: boolean
}

let frozenTerminalSurfaces: FrozenTerminalSurface[] = []
let resizeSession = 0
let settleFallbackTimer: number | null = null
let settleFrame = 0

/** 面板分隔条开始、最终对齐与结束拖动事件。 */
export const PANEL_RESIZE_BEGIN_EVENT = 'qingcode:panel-resize-begin'
export const PANEL_RESIZE_SETTLE_EVENT = 'qingcode:panel-resize-settle'
export const PANEL_RESIZE_END_EVENT = 'qingcode:panel-resize-end'

export function isPanelResizing(): boolean {
  return document.body.classList.contains(RESIZING_CLASS)
}

/**
 * 【终端防闪烁关键逻辑，请勿轻易修改或删除】
 *
 * 拖动开始时复制 xterm 最后一张完整画面，拖动中只缩放这张快照。WebGL canvas
 * 在 resize 时会同步清空，而 xterm 重绘是异步的；仅固定 DOM 宽高或等待一个
 * requestAnimationFrame 都不能保证 WebView2 不合成出空白帧。
 *
 * 修改这里时必须同时检查 Terminal.tsx 的 ResizeObserver / settle 逻辑，
 * 并在 Tauri 窗口中连续上下拖动终端面板验证无文字消失或白/黑帧。
 */
function captureTerminalSurfaces() {
  releaseTerminalSurfaces()
  document
    .querySelectorAll<HTMLElement>('[data-terminal-dock] [data-terminal-active="true"] .xterm')
    .forEach(surface => {
      const host = surface.parentElement
      const surfaceRect = surface.getBoundingClientRect()
      const sourceCanvases = Array.from(surface.querySelectorAll<HTMLCanvasElement>('canvas'))
      if (
        !host ||
        surfaceRect.width <= 0 ||
        surfaceRect.height <= 0 ||
        sourceCanvases.length === 0
      ) {
        return
      }

      const snapshot = document.createElement('canvas')
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      snapshot.width = Math.max(1, Math.round(surfaceRect.width * dpr))
      snapshot.height = Math.max(1, Math.round(surfaceRect.height * dpr))
      snapshot.className = SNAPSHOT_CLASS
      // 保持截图时的 CSS 像素尺寸；不能用 100% 跟随 dock 拉伸，否则字符会变高/变宽。
      snapshot.style.width = `${surfaceRect.width}px`
      snapshot.style.height = `${surfaceRect.height}px`
      snapshot.setAttribute('aria-hidden', 'true')
      const context = snapshot.getContext('2d')
      if (!context) return

      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      const style = window.getComputedStyle(surface)
      const background =
        style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? style.backgroundColor
          : style.getPropertyValue('--color-bg-deep').trim() || '#000'
      context.fillStyle = background
      context.fillRect(0, 0, surfaceRect.width, surfaceRect.height)

      let copiedCanvas = false
      for (const source of sourceCanvases) {
        const sourceRect = source.getBoundingClientRect()
        if (sourceRect.width <= 0 || sourceRect.height <= 0) continue
        try {
          context.drawImage(
            source,
            sourceRect.left - surfaceRect.left,
            sourceRect.top - surfaceRect.top,
            sourceRect.width,
            sourceRect.height
          )
          copiedCanvas = true
        } catch {
          // Keep trying other xterm render layers; no overlay is safer than a blank overlay.
        }
      }
      if (!copiedCanvas) return

      const addedHostClass = !host.classList.contains(SNAPSHOT_HOST_CLASS)
      if (addedHostClass) host.classList.add(SNAPSHOT_HOST_CLASS)
      surface.dataset.resizeFrozen = '1'
      host.appendChild(snapshot)
      frozenTerminalSurfaces.push({ surface, host, snapshot, addedHostClass })
    })
}

function releaseTerminalSurfaces() {
  for (const { surface, host, snapshot, addedHostClass } of frozenTerminalSurfaces) {
    snapshot.remove()
    delete surface.dataset.resizeFrozen
    if (addedHostClass) host.classList.remove(SNAPSHOT_HOST_CLASS)
  }
  frozenTerminalSurfaces = []
}

function cancelPendingSettle() {
  if (settleFallbackTimer !== null) {
    window.clearTimeout(settleFallbackTimer)
    settleFallbackTimer = null
  }
  if (settleFrame !== 0) {
    window.cancelAnimationFrame(settleFrame)
    settleFrame = 0
  }
}

export function beginPanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  resizeSession += 1
  cancelPendingSettle()
  document.body.classList.add(RESIZING_CLASS)
  document.body.dataset.panelResize = orientation
  document.body.style.userSelect = 'none'
  captureTerminalSurfaces()
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_BEGIN_EVENT))
}

/**
 * 【终端防闪烁关键时序，请勿改成直接 endPanelResize】
 *
 * settle 事件先让 Terminal.tsx 提交最终字符网格，并通过 waitUntil 等待 xterm
 * 的 onRender。onRender 后再保留快照一帧，确保新 WebGL 画面已被 WebView2 合成。
 * 不得退回“固定等待一个 rAF”或提前移除快照，否则忙碌终端会重新闪烁。
 */
export function settlePanelResize(orientation: PanelResizeOrientation = 'horizontal') {
  const session = resizeSession
  const readiness: Promise<unknown>[] = []
  let acceptingWaits = true
  const detail: PanelResizeSettleDetail = {
    orientation,
    waitUntil(value) {
      if (acceptingWaits) readiness.push(Promise.resolve(value))
    },
  }
  window.dispatchEvent(
    new CustomEvent<PanelResizeSettleDetail>(PANEL_RESIZE_SETTLE_EVENT, { detail })
  )
  acceptingWaits = false

  let waitFinished = false
  let fallbackTimer: number | null = null
  const finishWait = () => {
    if (waitFinished) return
    waitFinished = true
    if (fallbackTimer !== null) {
      window.clearTimeout(fallbackTimer)
      if (settleFallbackTimer === fallbackTimer) settleFallbackTimer = null
      fallbackTimer = null
    }
    if (session !== resizeSession || !isPanelResizing()) return
    settleFrame = window.requestAnimationFrame(() => {
      settleFrame = 0
      if (session === resizeSession && isPanelResizing()) endPanelResize(orientation)
    })
  }

  fallbackTimer = window.setTimeout(finishWait, PANEL_RESIZE_RENDER_TIMEOUT_MS)
  settleFallbackTimer = fallbackTimer
  void Promise.allSettled(readiness).then(finishWait)
}

export function endPanelResize(_orientation: PanelResizeOrientation = 'horizontal') {
  resizeSession += 1
  cancelPendingSettle()
  releaseTerminalSurfaces()
  document.body.classList.remove(RESIZING_CLASS)
  delete document.body.dataset.panelResize
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.dispatchEvent(new CustomEvent(PANEL_RESIZE_END_EVENT))
}
