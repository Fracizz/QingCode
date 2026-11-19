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

/** 换进来的大区域（如从终端列表切到另一个终端）：从活动栏一侧轻移 8px 淡入，与侧栏换页 .view-enter 一致；不留 transform。 */
export function enterLayoutRegion(element: Element | null | undefined) {
  if (!canAnimateLayout(element)) return
  const duration = cssDuration('--motion-view', 260)
  guardAnimation(element.animate(
    [
      { opacity: 0, transform: 'translateX(-8px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ],
    { duration, easing: EASE_SOFT },
  ), duration)
}

/** 面板布局切换（经典 / 侧边终端 / 终端工作台）后，让换了位置的区域整体淡入，只变透明度不位移。 */
export function fadeInLayoutRegions(elements: (Element | null | undefined)[]) {
  const duration = cssDuration('--motion-view', 260)
  for (const element of elements) {
    if (!canAnimateLayout(element)) continue
    guardAnimation(element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE_SOFT }), duration)
  }
}
