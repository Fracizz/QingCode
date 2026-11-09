import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

export type VerticalDropPosition = 'before' | 'after'

export interface VerticalDrop {
  id: string
  position: VerticalDropPosition
}

const DRAG_THRESHOLD_PX = 5
const AUTO_SCROLL_EDGE_PX = 28
const AUTO_SCROLL_STEP_PX = 8

/** 按纵坐标找最近的项和落点；落在两项之间的空隙时取最近的一项，列表分组的间距不会丢失落点。 */
export function nearestVerticalDrop(
  items: ReadonlyArray<{ id: string; top: number; bottom: number }>,
  y: number,
): VerticalDrop | null {
  let nearest: { id: string; top: number; bottom: number } | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const item of items) {
    const distance = y < item.top ? item.top - y : y > item.bottom ? y - item.bottom : 0
    if (distance < nearestDistance) {
      nearest = item
      nearestDistance = distance
    }
  }
  if (!nearest) return null
  return { id: nearest.id, position: y < (nearest.top + nearest.bottom) / 2 ? 'before' : 'after' }
}

interface Options {
  /** 匹配全部可作为落点的元素。 */
  targetSelector: string
  targetIdOf: (element: HTMLElement) => string | undefined
  /** 按下这些元素时不开始拖动，例如行内按钮。 */
  ignoreSelector: string
  listRef: RefObject<HTMLElement | null>
  canDrop: (sourceId: string, drop: VerticalDrop) => boolean
  onDrop: (sourceId: string, drop: VerticalDrop) => void
}

interface Session {
  sourceId: string
  pointerId: number
  startX: number
  startY: number
  active: boolean
  y: number
  scrollFrame: number | null
}

/**
 * 纵向列表的指针拖动排序。Tauri 接管原生拖放（文件拖入依赖它）后，
 * WebView2 收不到 HTML5 的 dragover / drop，所以不能用 draggable。
 */
export function useVerticalPointerReorder(options: Options) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [drop, setDrop] = useState<VerticalDrop | null>(null)
  const optionsRef = useRef(options)
  const endRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => () => endRef.current?.(), [])

  const start = (event: ReactPointerEvent<HTMLElement>, sourceId: string) => {
    if (event.button !== 0 || endRef.current) return
    if ((event.target as Element).closest(optionsRef.current.ignoreSelector)) return

    const session: Session = {
      sourceId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      y: event.clientY,
      scrollFrame: null,
    }
    let currentDrop: VerticalDrop | null = null

    const resolveDrop = () => {
      const { targetSelector, targetIdOf, listRef, canDrop } = optionsRef.current
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>(targetSelector) ?? [])].flatMap(element => {
        const id = targetIdOf(element)
        if (!id) return []
        const rect = element.getBoundingClientRect()
        return [{ id, top: rect.top, bottom: rect.bottom }]
      })
      const next = nearestVerticalDrop(items, session.y)
      currentDrop = next && next.id !== sourceId && canDrop(sourceId, next) ? next : null
      setDrop(currentDrop)
    }

    const stopScrolling = () => {
      if (session.scrollFrame !== null) cancelAnimationFrame(session.scrollFrame)
      session.scrollFrame = null
    }

    const autoScroll = () => {
      session.scrollFrame = null
      const list = optionsRef.current.listRef.current
      if (!list) return
      const rect = list.getBoundingClientRect()
      if (rect.height <= 0) return
      const delta =
        session.y < rect.top + AUTO_SCROLL_EDGE_PX
          ? -AUTO_SCROLL_STEP_PX
          : session.y > rect.bottom - AUTO_SCROLL_EDGE_PX
            ? AUTO_SCROLL_STEP_PX
            : 0
      if (delta === 0) return
      const before = list.scrollTop
      list.scrollTop += delta
      if (list.scrollTop === before) return
      resolveDrop()
      session.scrollFrame = requestAnimationFrame(autoScroll)
    }

    const finish = () => {
      stopScrolling()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown, true)
      document.body.classList.remove('select-none')
      endRef.current = null
      setDraggedId(null)
      setDrop(null)
    }

    // 拖动结束时浏览器仍会在按下的元素上派发一次 click，不能让它选中终端或折叠分组。
    const swallowNextClick = () => {
      const swallow = (clickEvent: MouseEvent) => {
        clickEvent.stopPropagation()
        clickEvent.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== session.pointerId) return
      session.y = moveEvent.clientY
      if (!session.active) {
        const dx = moveEvent.clientX - session.startX
        const dy = moveEvent.clientY - session.startY
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        session.active = true
        document.body.classList.add('select-none')
        setDraggedId(sourceId)
      }
      resolveDrop()
      if (session.scrollFrame === null) autoScroll()
    }

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== session.pointerId) return
      const dropped = session.active ? currentDrop : null
      const wasActive = session.active
      finish()
      if (wasActive) swallowNextClick()
      if (dropped) optionsRef.current.onDrop(sourceId, dropped)
    }

    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === session.pointerId) finish()
    }

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape' || !session.active) return
      keyEvent.preventDefault()
      keyEvent.stopPropagation()
      finish()
      swallowNextClick()
    }

    endRef.current = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown, true)
  }

  return { draggedId, drop, start }
}
