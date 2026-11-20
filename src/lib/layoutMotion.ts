// 布局级动效（见 DESIGN.md「动效一览」）：面板宽度过渡与原地淡入。
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

export function animatePanelWidth(element: HTMLElement, from: number, to: number, expanded: number) {
  const duration = Math.max(60, cssDuration('--motion-layout', 180) * Math.min(1, Math.abs(to - from) / expanded))
  const animation = element.animate([{ width: `${from}px` }, { width: `${to}px` }], {
    duration,
    easing: EASE_SOFT,
    fill: 'both',
  })
  guardAnimation(animation, duration)
  return animation
}

function fadeIn(element: HTMLElement, duration: number, fromOpacity = 0) {
  const animation = element.animate([{ opacity: fromOpacity }, { opacity: 1 }], { duration, easing: EASE_SOFT })
  guardAnimation(animation, duration)
  return animation
}

export interface RegionCrossfade {
  incoming: HTMLElement
  outgoing: Element | null | undefined
  fade: Animation
  finished: Promise<unknown>
  cancel: () => void
}

/**
 * 同一窗格只保留最近一轮交接。反向切换时交换上、下层，从当前的混合比例接着播；
 * 连切到第三个会话时只留下紧邻的上一会话，缩短下一轮淡入。
 */
export function crossfadeRegion(
  incoming: Element | null | undefined,
  outgoing?: Element | null,
  previous?: RegionCrossfade,
): RegionCrossfade | undefined {
  if (!canAnimateLayout(incoming)) {
    previous?.cancel()
    return
  }
  const interrupted = previous && (previous.fade.pending || previous.fade.playState === 'running')
  let fromOpacity = outgoing ? 0 : 0.45
  const reversing = interrupted && previous.outgoing === incoming && previous.incoming === outgoing
  if (reversing) {
    fromOpacity = 1 - Number(getComputedStyle(previous.incoming).opacity)
  } else if (interrupted && !outgoing && previous.incoming === incoming) {
    // 分屏在同一个容器里直接换内容，沿用容器当前的透明度。
    fromOpacity = Number(getComputedStyle(incoming).opacity)
  }
  previous?.cancel()
  if (fromOpacity >= 1) return

  const base = cssDuration('--motion-fast', 120)
  const duration = interrupted ? Math.max(40, base * (1 - fromOpacity)) : base
  const fade = fadeIn(incoming, duration, fromOpacity)
  const reveal = outgoing instanceof HTMLElement && outgoing !== incoming
    ? outgoing.animate([{ visibility: 'visible' }, { visibility: 'visible' }], { duration })
    : undefined
  if (reveal) guardAnimation(reveal, duration)
  const finished = Promise.allSettled(reveal ? [fade.finished, reveal.finished] : [fade.finished])
  return {
    incoming, outgoing, fade, finished,
    cancel: () => {
      fade.cancel()
      reveal?.cancel()
    },
  }
}

/** 子页淡入的起始不透明度：不从全透明开始，避免换页瞬间整块闪黑。 */
export const SUBPAGE_FADE_FROM = 0.35

/** 同级子页只淡入正文：从半透明过渡到不透明，时长取 --motion-enter，比 .view-fade 更柔和。 */
export function fadeInSubpage(element: Element | null) {
  if (!canAnimateLayout(element)) return
  return fadeIn(element, cssDuration('--motion-enter', 140), SUBPAGE_FADE_FROM)
}
