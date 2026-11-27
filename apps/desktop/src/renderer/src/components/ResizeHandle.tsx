import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '../lib/cn'

/**
 * 全局统一的拖拽分隔条（沿用旧版 QingCode 的 PanelResizer 外观与手感）：
 * - 光标用 ew-resize / ns-resize 双向箭头，拖动期间锁定到整个页面，划过其它元素也不变；
 * - 平时不可见，悬停显示细线 + 三点握把，拖动/键盘聚焦时变青色；
 * - 双击或聚焦后按 Enter 复位；方向键调整（Shift 五倍步长），Home/End 到最小/最大。
 * orientation 指分隔条本身的走向：vertical = 竖条、左右拖改宽度；horizontal = 横条、上下拖改高度。
 */
export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  onChange,
  onReset,
  label,
  direction = 1,
  step = 10,
  className,
}: {
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  onReset?: () => void
  label: string
  /** 1：向右/向下拖变大（左侧/顶部面板）；-1：向左/向上拖变大（右侧/底部面板）。 */
  direction?: 1 | -1
  step?: number
  className?: string
}) {
  const [active, setActive] = useState(false)
  const drag = useRef<{ start: number; startValue: number } | null>(null)
  const vertical = orientation === 'vertical'

  // 拖动期间给 body 打标，全局锁定光标并禁止选中文字。
  useEffect(() => {
    if (!active) return
    const body = document.body
    body.classList.add('qn-resizing')
    body.dataset.qnResize = orientation
    return () => {
      body.classList.remove('qn-resizing')
      delete body.dataset.qnResize
    }
  }, [active, orientation])

  const clamp = (next: number): number => Math.min(max, Math.max(min, next))

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { start: vertical ? event.clientX : event.clientY, startValue: value }
    setActive(true)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    const delta = (vertical ? event.clientX : event.clientY) - drag.current.start
    onChange(clamp(drag.current.startValue + delta * direction))
  }
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = null
    setActive(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' && onReset) {
      event.preventDefault()
      onReset()
      return
    }
    const decrease = vertical ? 'ArrowLeft' : 'ArrowUp'
    const increase = vertical ? 'ArrowRight' : 'ArrowDown'
    let next: number
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === decrease || event.key === increase) {
      next = value + (event.key === decrease ? -1 : 1) * direction * step * (event.shiftKey ? 5 : 1)
    } else return
    event.preventDefault()
    onChange(clamp(next))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-orientation={orientation}
      data-active={active}
      className={cn('qn-resizer', className ?? 'relative')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="qn-resizer-line" aria-hidden />
      <span className="qn-resizer-grip" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  )
}
