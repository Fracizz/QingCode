import { t } from '@qn/codex-client'
import { useMobilePreferences } from './mobilePreferences'
import { useApp } from './store'

const MAX_BOOT_WAIT_MS = 8000
const MIN_VISIBLE_MS = 1000
const REDUCED_MIN_VISIBLE_MS = 500
const READY_HOLD_MS = 180
// 与 styles.css 中进场页的淡出时长一致。
const FADE_MS = 1000
const REDUCED_FADE_MS = 500

/** 本地连接读取和动画并行，进场页只在 WebView 初次加载时出现。 */
export function startSplash(root: HTMLElement): void {
  const splash = document.getElementById('qn-splash')
  if (!splash) {
    root.removeAttribute('inert')
    return
  }

  const { theme, reduceMotion } = useMobilePreferences.getState()
  document.documentElement.dataset.theme = theme
  document.documentElement.toggleAttribute('data-reduce-motion', reduceMotion)
  const reduced = reduceMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  const status = splash.querySelector('.qn-splash-status')
  splash.setAttribute('aria-label', t('QingCode Next 正在启动'))
  if (status) status.textContent = t('正在启动')

  const startedAt = performance.now()
  const finish = (ready: boolean) => {
    unsubscribe()
    window.clearTimeout(deadline)
    const leave = () => {
      splash.dataset.leaving = ''
      window.setTimeout(() => {
        splash.remove()
        root.removeAttribute('inert')
      }, reduced ? REDUCED_FADE_MS : FADE_MS)
    }
    const showReady = () => {
      if (ready) {
        splash.dataset.ready = ''
        if (status) status.textContent = t('准备就绪')
      }
      if (ready && !reduced) window.setTimeout(leave, READY_HOLD_MS)
      else leave()
    }
    const minVisible = reduced ? REDUCED_MIN_VISIBLE_MS : MIN_VISIBLE_MS
    const remaining = minVisible - (performance.now() - startedAt)
    if (remaining > 0) window.setTimeout(showReady, remaining)
    else showReady()
  }

  const unsubscribe = useApp.subscribe(({ booting }) => {
    if (!booting) finish(true)
  })
  const deadline = window.setTimeout(() => finish(false), MAX_BOOT_WAIT_MS)
  if (!useApp.getState().booting) finish(true)
}
