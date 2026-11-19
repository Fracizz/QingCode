// 布局级动效（见 DESIGN.md「动效一览」）：侧栏展开 / 收起的宽度过渡、切换面板布局后的区域淡入。
// 只用 Web Animations，参数取 animations.css 的 CSS 变量；减少动效、窗口在后台或不支持时直接跳过。
import { motionReduced } from './motionPreferences'

/** 与 animations.css 中 --ease-soft 一致：平缓减速，不在开头猛冲。 */
export const EASE_SOFT = 'cubic-bezier(0.2, 0, 0, 1)'

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

/** 面板布局切换（经典 / 侧边终端 / 终端工作台）后，让换了位置的区域整体淡入，只变透明度不位移。 */
export function fadeInLayoutRegions(elements: (Element | null | undefined)[]) {
  const duration = cssDuration('--motion-enter', 160)
  for (const element of elements) {
    if (!canAnimateLayout(element)) continue
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: EASE_SOFT })
  }
}
