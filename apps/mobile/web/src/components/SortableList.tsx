import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dropIndex, LONG_PRESS_MS, LONG_PRESS_SLOP, shiftFor } from '../sortable'

type Drag = { from: number; to: number; offset: number; height: number }

/**
 * 长按某一行后上下拖动排序（手机端没有悬停与拖拽手柄，长按是最自然的入口）。
 * 触摸事件用原生非 passive 监听：拖动中要阻止页面滚动，React 的 touchmove 是 passive 的。
 */
export function SortableList<T>({ items, itemKey, onMove, disabled = false, label, className = 'qn-list-group', children }: {
  items: readonly T[]
  itemKey: (item: T) => string
  onMove: (from: number, to: number) => void
  disabled?: boolean
  label: string
  className?: string
  children: (item: T) => ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const latest = useRef({ onMove, count: items.length })
  latest.current = { onMove, count: items.length }

  useEffect(() => {
    const root = list.current
    if (!root || disabled) return
    let timer: number | undefined
    let start: { x: number; y: number; index: number } | null = null
    let slots: [number, number][] = []
    let active: Drag | null = null
    let suppressClick = false

    const point = (event: TouchEvent | PointerEvent) =>
      'touches' in event ? event.touches[0] ?? event.changedTouches[0] : event
    const reset = () => {
      window.clearTimeout(timer)
      start = null
      active = null
      setDrag(null)
    }
    const begin = (event: TouchEvent | PointerEvent) => {
      if (latest.current.count < 2) return
      const row = (event.target as Element | null)?.closest<HTMLElement>('[data-sort-index]')
      const p = point(event)
      if (!row || !p || !root.contains(row)) return
      start = { x: p.clientX, y: p.clientY, index: Number(row.dataset.sortIndex) }
      timer = window.setTimeout(() => {
        if (!start) return
        slots = [...root.querySelectorAll<HTMLElement>(':scope > [data-sort-index]')]
          .map((el) => { const rect = el.getBoundingClientRect(); return [rect.top, rect.height] })
        const height = slots[start.index]?.[1] ?? 0
        active = { from: start.index, to: start.index, offset: 0, height }
        setDrag(active)
        navigator.vibrate?.(12)
      }, LONG_PRESS_MS)
    }
    const move = (event: TouchEvent | PointerEvent) => {
      const p = point(event)
      if (!start || !p) return
      if (!active) {
        // 长按判定前就移动了：交给浏览器滚动。
        if (Math.hypot(p.clientX - start.x, p.clientY - start.y) > LONG_PRESS_SLOP) reset()
        return
      }
      if (event.cancelable) event.preventDefault()
      const offset = p.clientY - start.y
      active = { ...active, offset, to: dropIndex(slots, active.from, offset) }
      setDrag(active)
    }
    const end = () => {
      if (active) {
        suppressClick = true
        if (active.to !== active.from) latest.current.onMove(active.from, active.to)
      }
      reset()
    }
    // 拖完松手会在行内按钮上合成一次 click，吞掉它以免误打开项目。
    const click = (event: MouseEvent) => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }
    const contextMenu = (event: Event) => { if (start) event.preventDefault() }
    const pointerDown = (event: PointerEvent) => { if (event.pointerType === 'mouse' && event.button === 0) begin(event) }
    const pointerMove = (event: PointerEvent) => { if (event.pointerType === 'mouse') move(event) }
    const pointerUp = (event: PointerEvent) => { if (event.pointerType === 'mouse') end() }

    root.addEventListener('touchstart', begin, { passive: true })
    root.addEventListener('touchmove', move, { passive: false })
    root.addEventListener('touchend', end)
    root.addEventListener('touchcancel', reset)
    root.addEventListener('pointerdown', pointerDown)
    window.addEventListener('pointermove', pointerMove)
    window.addEventListener('pointerup', pointerUp)
    root.addEventListener('click', click, true)
    root.addEventListener('contextmenu', contextMenu)
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener('touchstart', begin)
      root.removeEventListener('touchmove', move)
      root.removeEventListener('touchend', end)
      root.removeEventListener('touchcancel', reset)
      root.removeEventListener('pointerdown', pointerDown)
      window.removeEventListener('pointermove', pointerMove)
      window.removeEventListener('pointerup', pointerUp)
      root.removeEventListener('click', click, true)
      root.removeEventListener('contextmenu', contextMenu)
    }
  }, [disabled])

  return (
    <div ref={list} className={`${className} qn-sortable`} data-sorting={drag !== null} aria-label={label}>
      {items.map((item, index) => {
        const dragging = drag?.from === index
        const shift = drag && !dragging ? shiftFor(index, drag.from, drag.to, drag.height) : 0
        return (
          <div key={itemKey(item)} data-sort-index={index} className="qn-sortable-item" data-dragging={dragging || undefined}
            style={dragging ? { transform: `translateY(${drag.offset}px)` } : shift ? { transform: `translateY(${shift}px)` } : undefined}>
            {children(item)}
          </div>
        )
      })}
    </div>
  )
}
