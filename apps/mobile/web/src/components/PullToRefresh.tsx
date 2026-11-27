import { ArrowDown } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { LoadingIcon, Note } from './ui'

const TOUCH_SLOP = 8
const REFRESH_DISTANCE = 56
const MAX_DISTANCE = 80

function pullDistance(delta: number): number {
  return Math.max(0, Math.min(MAX_DISTANCE, (delta - TOUCH_SLOP) * 0.65))
}

export function PullToRefresh({
  label, className, disabled, onRefresh, children,
}: {
  label: string
  className: string
  disabled?: boolean
  onRefresh: () => Promise<void>
  children: ReactNode
}) {
  const main = useRef<HTMLElement>(null)
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [failed, setFailed] = useState(false)
  const isDisabled = useEffectEvent(() => disabled)
  const refresh = useEffectEvent(() => onRefresh())

  useEffect(() => {
    const node = main.current
    if (!node) return
    const atTop = () => node.scrollTop <= 0
    let gesture: { id: number; x: number; y: number; pulling: boolean } | null = null
    let pending = false
    let mounted = true

    function cancel() {
      if (gesture?.pulling) setDistance(0)
      gesture = null
    }

    function start(event: TouchEvent) {
      cancel()
      const touch = event.touches[0]
      if (pending || isDisabled() || !atTop() || event.touches.length !== 1 || !touch) return
      const target = event.target
      if (target instanceof Element
        && target.closest('dialog, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, pulling: false }
    }

    function move(event: TouchEvent) {
      if (!gesture) return
      const touch = event.touches[0]
      if (event.touches.length !== 1 || touch?.identifier !== gesture.id || !atTop()) {
        cancel()
        return
      }
      const dx = touch.clientX - gesture.x
      const dy = touch.clientY - gesture.y
      if (!gesture.pulling) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < TOUCH_SLOP) return
        // 方向一旦确定就保持到抬手，横滑归档和普通滚动仍交给原来的处理。
        if (dy <= Math.abs(dx)) {
          cancel()
          return
        }
        gesture.pulling = true
      }
      if (event.cancelable) event.preventDefault()
      setDistance(pullDistance(dy))
    }

    async function finish(event: TouchEvent) {
      const current = gesture
      cancel()
      const touch = event.changedTouches[0]
      if (!current?.pulling || touch?.identifier !== current.id || isDisabled() || !atTop()
        || pullDistance(touch.clientY - current.y) < REFRESH_DISTANCE) return
      pending = true
      setRefreshing(true)
      setFailed(false)
      try {
        await refresh()
      } catch {
        if (mounted) setFailed(true)
      } finally {
        pending = false
        if (mounted) setRefreshing(false)
      }
    }

    node.addEventListener('touchstart', start, { passive: true })
    // React 的 touchmove 默认是 passive，只在接管向下的手势后阻止 WebView 滚动。
    node.addEventListener('touchmove', move, { passive: false })
    node.addEventListener('touchend', finish, { passive: true })
    node.addEventListener('touchcancel', cancel, { passive: true })
    return () => {
      mounted = false
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', move)
      node.removeEventListener('touchend', finish)
      node.removeEventListener('touchcancel', cancel)
    }
  }, [])

  return (
    <div className="qn-pull-refresh">
      <main ref={main} className={`${className} qn-pull-scroll`} aria-label={label} aria-busy={refreshing}>
        {failed && <Note message="刷新失败，请重试。" tone="error" onClose={() => setFailed(false)} />}
        {children}
      </main>
      {(distance > 0 || refreshing) && (
        <div className="qn-pull-indicator" role="status"
          style={{ transform: `translate(-50%, ${refreshing ? REFRESH_DISTANCE : distance}px)` }}>
          {refreshing ? <LoadingIcon /> : <ArrowDown size={14} aria-hidden />}
          {refreshing ? '正在刷新…' : distance >= REFRESH_DISTANCE ? '松手刷新' : '下拉刷新'}
        </div>
      )}
    </div>
  )
}
