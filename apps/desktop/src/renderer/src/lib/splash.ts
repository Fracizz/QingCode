// 进场页（index.html 里的 #qn-splash）的时序与 DOM 控制。纯函数在前，便于单测。

/** 入场动画最晚结束于约 1000ms（光标 400ms 延迟 + 420ms，再留一点品牌停留）。 */
export const SPLASH_MIN_VISIBLE_MS = 1200
export const SPLASH_REDUCED_MIN_VISIBLE_MS = 300
/** 与 index.html 中 .qn-splash 的 transition 时长一致。 */
export const SPLASH_FADE_MS = 360
/** 后台迟迟不就绪也不能把用户挡在进场页外。 */
export const SPLASH_MAX_WAIT_MS = 8000
/** 进度条从"滑动"切到"填满"后停留一下再淡出，让用户看到完成态。 */
export const SPLASH_READY_HOLD_MS = 220

export type BootPhase = 'starting' | 'backend' | 'targets' | 'ready'

const PHASE_TEXT: Record<BootPhase, string> = {
  starting: '正在启动',
  backend: '正在连接后台服务…',
  targets: '正在加载连接与项目…',
  ready: '准备就绪',
}

export function bootPhaseText(phase: BootPhase): string {
  return PHASE_TEXT[phase]
}

/** 还需等待多久才开始淡出：保证最短展示，已超时则立即淡出。 */
export function splashDismissDelay(
  elapsedMs: number,
  options: { reducedMotion?: boolean; smoke?: boolean } = {},
): number {
  if (options.smoke) return 0
  const min = options.reducedMotion ? SPLASH_REDUCED_MIN_VISIBLE_MS : SPLASH_MIN_VISIBLE_MS
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return min
  return Math.max(0, min - elapsedMs)
}

const SPLASH_ID = 'qn-splash'

function splashElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(SPLASH_ID)
}

export function setSplashStatus(phase: BootPhase): void {
  const status = typeof document === 'undefined' ? null : document.getElementById('qn-splash-status')
  if (status) status.textContent = bootPhaseText(phase)
}

export function setSplashFooter(text: string): void {
  const foot = typeof document === 'undefined' ? null : document.getElementById('qn-splash-foot')
  if (foot) foot.textContent = text
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

let dismissing: Promise<void> | null = null

/**
 * 标记就绪并在满足最短展示后淡出、移除进场页。
 * onLeave 在淡出开始时调用（主界面此时开始入场动画）；重复调用不会重复淡出，后来者的 onLeave 在淡出完成后补调。
 */
export function dismissSplash(onLeave?: () => void): Promise<void> {
  if (dismissing) {
    // 热更新或 StrictMode 重新挂载时，新组件也要拿到"已入场"的回调，否则主界面会停在透明态。
    if (onLeave) void dismissing.then(onLeave)
    return dismissing
  }
  const el = splashElement()
  if (!el) {
    onLeave?.()
    dismissing = Promise.resolve()
    return dismissing
  }
  const reducedMotion = prefersReducedMotion()
  const smoke = typeof window !== 'undefined' && window.qn?.isSmoke === true
  // performance.now() 从导航开始计时，进场页随 HTML 解析几乎同时绘制，足够近似。
  const delay = splashDismissDelay(performance.now(), { reducedMotion, smoke })
  setSplashStatus('ready')
  el.classList.add('qn-splash--ready')

  dismissing = new Promise<void>((resolve) => {
    window.setTimeout(() => {
      el.classList.add('qn-splash--leave')
      onLeave?.()
      window.setTimeout(() => {
        el.remove()
        resolve()
      }, reducedMotion ? 140 : SPLASH_FADE_MS + 40)
    }, delay + (smoke ? 0 : SPLASH_READY_HOLD_MS))
  })
  return dismissing
}
