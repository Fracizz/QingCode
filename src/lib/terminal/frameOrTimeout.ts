/**
 * 下一帧与计时器竞速执行一次回调，返回取消函数。
 *
 * 窗口在后台或被遮挡时 WebView2 不再出帧，requestAnimationFrame 一直不回调；
 * 量终端网格只需读布局，不依赖出帧，由计时器兜底，新建终端不必等满 PTY 兜底时长。
 * 前台下一帧（约 16ms）总是先到，行为与纯 rAF 一致；计时器只在不出帧时抢先，
 * 此时屏幕上本来就没有画面，也就不会露出 WebGL 画布清空的空白帧。
 */
export const FRAME_FALLBACK_MS = 50

export function runOnFrameOrTimeout(callback: () => void, timeoutMs: number = FRAME_FALLBACK_MS): () => void {
  let done = false
  let raf = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (raf !== 0) globalThis.cancelAnimationFrame(raf)
    if (timer !== undefined) clearTimeout(timer)
    raf = 0
    timer = undefined
  }
  const run = () => {
    if (done) return
    done = true
    cancel()
    callback()
  }
  raf = globalThis.requestAnimationFrame(run)
  timer = setTimeout(run, timeoutMs)
  return () => {
    done = true
    cancel()
  }
}
