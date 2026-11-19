// 布局级动效（见 DESIGN.md「动效一览」）：侧栏展开 / 收起的宽度过渡、切换面板布局后的区域淡入。
// 只用 Web Animations，参数取 animations.css 的 CSS 变量；减少动效、窗口在后台或不支持时直接跳过。
import { motionReduced } from './motionPreferences'

/** 与 animations.css 中 --ease-soft 一致：起步轻、收尾长，不在开头猛冲。 */
export const EASE_SOFT = 'cubic-bezier(0.3, 0, 0.2, 1)'

/** 读取时长类 CSS 变量（ms），读不到时用 fallback。 */
export function cssDuration(name: string, fallback: number): number {
  try {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
    if (Number.isFinite(value) && value > 0) return value
  } catch {}
  return fallback
}

/** 当前能否播放布局动效。 */
export function canAnimateLayout(element: Element | null | undefined): element is HTMLElement {
  if (typeof document === 'undefined' || !(element instanceof HTMLElement)) return false
  if (typeof element.animate !== 'function') return false
  return !motionReduced() && document.visibilityState !== 'hidden'
}

/**
 * 兜底：动画若迟迟没有推进（窗口未合成、被遮挡等），到期直接跳到终点，
 * 避免区域停在透明或侧栏卡在收拢途中。finish() 会照常触发 onfinish。
 */
export function guardAnimation(animation: Animation, duration: number) {
  setTimeout(() => {
    if (animation.playState === 'running' || animation.playState === 'paused') {
      try { animation.finish() } catch {}
    }
  }, duration + 300)
}

/**
 * 原地换内容的交叉淡化（如切换终端）：新内容在上层从透明淡入，旧内容在下层保持完全显示直到淡入结束，
 * 合成亮度始终不掉，没有「旧的先消失、露出空底再出新的」那一下；不位移，避免整屏文字滑动显得生硬。
 * outgoing 已被样式隐藏（visibility: hidden）时，动画期间临时保持可见。
 */
export function crossfadeRegion(incoming: Element | null | undefined, outgoing?: Element | null) {
  if (!canAnimateLayout(incoming)) return
  const duration = cssDuration('--motion-view', 260)
  guardAnimation(incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE_SOFT }), duration)
  if (outgoing instanceof HTMLElement && outgoing !== incoming) {
    guardAnimation(
      outgoing.animate([{ visibility: 'visible' }, { visibility: 'visible' }], { duration }),
      duration,
    )
  }
}

/** 面板布局切换（经典 / 侧边终端 / 终端工作台）后，让换了位置的区域整体淡入，只变透明度不位移。 */
export function fadeInLayoutRegions(elements: (Element | null | undefined)[]) {
  const duration = cssDuration('--motion-view', 260)
  for (const element of elements) {
    if (!canAnimateLayout(element)) continue
    guardAnimation(element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE_SOFT }), duration)
  }
}
