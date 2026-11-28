import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { dropIndex, LONG_PRESS_MS, LONG_PRESS_SLOP, shiftFor } from '../sortable'

type Drag = { from: number; to: number; offset: number; height: number }

/**
 * 长按某一行后上下拖动排序（手机端没有悬停与拖拽手柄，长按是最自然的入口）。
 * 触摸事件用原生非 passive 监听：拖动中要阻止页面滚动，React 的 touchmove 是 passive 的。
 */
export function SortableList<T>({ items, itemKey, onMove, disabled = false, label, className = 'qn-list-group', handle, collapse = false, clamp, children }: {
  items: readonly T[]
  itemKey: (item: T) => string
  onMove: (from: number, to: number) => void
  disabled?: boolean
  label: string
  className?: string
  /** 只有按在匹配该选择器的元素上才能开始排序；缺省整行可按。 */
  handle?: string
  /** 行很高时（如整个分组），拖动期间由样式按 data-collapsed 收起内容，松手后展开。 */
  collapse?: boolean
  /** 限制落点范围，例如置顶项与普通项不能互换。 */
  clamp?: (from: number, to: number) => number
  children: (item: T) => ReactNode
}) {
  const list = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const options = { onMove, count: items.length, handle, collapse, clamp }
  const latest = useRef(options)
  latest.current = options

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
    const expand = () => {
      delete root.dataset.collapsed
      root.style.minHeight = ''
      root.style.paddingTop = ''
    }
    const reset = () => {
      window.clearTimeout(timer)
      expand()
      start = null
      active = null
      setDrag(null)
    }
    const begin = (event: TouchEvent | PointerEvent) => {
      // 长按松手后不一定合成 click，新的一次按下不能再被吞掉。
      suppressClick = false
      const { count, handle } = latest.current
      if (count < 2) return
      const target = event.target as Element | null
      if (handle && !target?.closest(handle)) return
      const row = target?.closest<HTMLElement>('[data-sort-index]')
      const p = point(event)
      if (!row || !p || !root.contains(row)) return
      start = { x: p.clientX, y: p.clientY, index: Number(row.dataset.sortIndex) }
      timer = window.setTimeout(() => {
        if (!start) return
        if (latest.current.collapse) {
          // 先锁住总高度再收起，滚动位置不会被浏览器挪动；用上内边距让被按住的行留在手指下。
          const top = row.getBoundingClientRect().top
          root.style.minHeight = `${root.offsetHeight}px`
          root.dataset.collapsed = 'true'
          root.style.paddingTop = `${Math.max(0, top - row.getBoundingClientRect().top)}px`
        }
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
      const to = dropIndex(slots, active.from, offset)
      active = { ...active, offset, to: latest.current.clamp?.(active.from, to) ?? to }
      setDrag(active)
    }
    const end = () => {
      if (!active) return reset()
      const { from, to } = active
      suppressClick = true
      const row = root.dataset.collapsed ? root.querySelector<HTMLElement>(`:scope > [data-sort-index="${from}"]`) : null
      const released = row?.getBoundingClientRect().top
      // 先让新顺序和复位后的位移落到 DOM，再展开内容并把移动的行滚回松手处。
      // 测量时关掉过渡，否则读到的是复位动画起点的位置。
      if (row) root.dataset.dropping = 'true'
      flushSync(() => {
        if (to !== from) latest.current.onMove(from, to)
        setDrag(null)
      })
      reset()
      const scroller = root.closest('.qn-scroll')
      if (row && released !== undefined && scroller) scroller.scrollTop += row.getBoundingClientRect().top - released
      delete root.dataset.dropping
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
