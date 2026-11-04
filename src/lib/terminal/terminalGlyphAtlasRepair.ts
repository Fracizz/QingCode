/**
 * xterm WebGL 字形图集的自愈调度。
 *
 * 图集页数达到上限时，xterm 会把旧页合并成一张更大的页，合并后字形的纹理坐标随之改变。
 * 同配置的终端共享同一个图集，但「需要重建模型」的标记只会被第一个检查它的渲染器消费；
 * 其余终端中未变化的单元格仍引用旧坐标，就会从错误位置取字形，表现为长时间运行后
 * 偶现的乱码/字形碎片（尤其是中文，以及 Claude Code 这类每帧给字符换色的动画，
 * 每个「字符 + 颜色」组合都占一个图集位置，很快触发合并）。
 *
 * 处理方式：监听图集页被移除（即发生了合并），防抖后清空图集并重建本终端的渲染模型。
 * 共享图集的终端都会收到同一事件，各自重建，互不依赖那个一次性的标记。
 */

/** 合并通常成批发生（一次移除多页），合并后等这么久再统一重建。 */
export const GLYPH_ATLAS_REPAIR_DELAY_MS = 120

export type GlyphAtlasRepairScheduler = {
  /** 记录一次图集页移除；短时间内多次只重建一次。 */
  schedule(): void
  /** 立即重建（手动「重绘终端显示」），并取消待执行的重建。 */
  repairNow(): void
  dispose(): void
}

/** 计时器注入点（测试用假计时器）；句柄类型在浏览器与 Node 下不同，按不透明值处理。 */
export type GlyphAtlasRepairTimers = {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export function createGlyphAtlasRepairScheduler(
  repair: () => void,
  delayMs = GLYPH_ATLAS_REPAIR_DELAY_MS,
  timers: GlyphAtlasRepairTimers = window,
): GlyphAtlasRepairScheduler {
  let timer: unknown = null
  let disposed = false

  const cancel = () => {
    if (timer === null) return
    timers.clearTimeout(timer)
    timer = null
  }

  const run = () => {
    timer = null
    if (disposed) return
    try {
      repair()
    } catch {
      // 渲染器可能已被回收或上下文丢失；下次合并或重新挂载时再修复。
    }
  }

  return {
    schedule() {
      if (disposed || timer !== null) return
      timer = timers.setTimeout(run, delayMs)
    },
    repairNow() {
      cancel()
      run()
    },
    dispose() {
      disposed = true
      cancel()
    },
  }
}
