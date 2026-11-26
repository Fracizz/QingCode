import { useEffect, useState } from 'react'
import { whenBackendReady } from '../lib/backend'
import { SPLASH_MAX_WAIT_MS, dismissSplash, setSplashFooter, setSplashStatus } from '../lib/splash'
import { useTargets } from '../store/targets'

/**
 * 驱动进场页：后台通道建立 → 目标列表加载完成（成功或失败都算）→ 淡出。
 * 返回主界面是否已开始入场，用于触发分区错峰动画。
 */
export function useBootSplash(): boolean {
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      void dismissSplash(() => setEntered(true))
    }

    setSplashStatus('backend')
    void window.qn
      ?.version()
      .then((version) => setSplashFooter(`v${version}`))
      .catch(() => undefined)
    void whenBackendReady().then(() => {
      if (!finished) setSplashStatus('targets')
    })

    const settled = () => {
      const state = useTargets.getState()
      return state.loaded || state.error !== null
    }
    if (settled()) finish()
    const unsubscribe = useTargets.subscribe(() => {
      if (settled()) finish()
    })
    // 后台卡住也不能一直挡着，超时后直接进入主界面（界面里会显示错误）。
    const timer = setTimeout(finish, SPLASH_MAX_WAIT_MS)
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  return entered
}
