import { useEffect, useRef, useState } from 'react'

/** 连接正常过之后，失联持续这么久才提示（参考 Orca 手机版 calm-connection-state）。 */
export const CALM_REVEAL_MS = 5000
/** 提示一旦出现至少停留这么久，避免一闪而过。 */
export const CALM_HOLD_MS = 2000

/**
 * 「平静」的连接提示：切后台回来、网络抖一下自动重连成功时不打扰用户。
 * 从未连上过时（如首次连接失败）立即提示，用户需要马上知道原因。
 */
export function useCalmWarning(warning: string | null, everConnected: boolean): string | null {
  const [shown, setShown] = useState<string | null>(null)
  const shownAt = useRef(0)
  const latest = useRef(warning)
  latest.current = warning
  const active = warning !== null

  useEffect(() => {
    if (active) {
      if (shown !== null) return
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now()
        setShown(latest.current)
      }, everConnected ? CALM_REVEAL_MS : 0)
      return () => window.clearTimeout(timer)
    }
    if (shown === null) return
    const timer = window.setTimeout(() => setShown(null), Math.max(0, CALM_HOLD_MS - (Date.now() - shownAt.current)))
    return () => window.clearTimeout(timer)
  }, [active, shown, everConnected])

  // 已显示时文案随最新错误更新；失联结束后在停留期内保留最后一条。
  return shown === null ? null : warning ?? shown
}
