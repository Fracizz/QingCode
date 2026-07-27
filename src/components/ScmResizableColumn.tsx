import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import PanelResizer from './PanelResizer'
import { beginPanelResize, endPanelResize } from '../lib/panelResize'

type Props = {
  width: number
  minWidth: number
  maxWidth: number
  /** Leave at least this many px for content on the opposite side of the resizer. */
  remainingMin?: number
  /**
   * `end` (default): column on the left, grip on the right (drag right → wider).
   * `start`: grip on the left, column on the right (drag left → wider).
   */
  edge?: 'start' | 'end'
  onWidthChange: (width: number) => void
  tooltip: string
  children: ReactNode
  className?: string
}

/** Vertical split column + PanelResizer (same interaction as sidebar / minimap). */
export default function ScmResizableColumn({
  width,
  minWidth,
  maxWidth,
  remainingMin = 0,
  edge = 'end',
  onWidthChange,
  tooltip,
  children,
  className,
}: Props) {
  const [active, setActive] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startW: number
    containerWidth?: number
    nextWidth: number
  } | null>(null)
  const dragFrameRef = useRef(0)
  const cancelDragRef = useRef<(() => void) | null>(null)

  const clampWidth = useCallback(
    (next: number, containerWidth?: number) => {
      let safeMax = maxWidth
      if (containerWidth != null && containerWidth > 0) {
        safeMax = Math.min(safeMax, Math.max(minWidth, containerWidth - remainingMin))
      }
      return Math.min(safeMax, Math.max(minWidth, Math.round(next)))
    },
    [maxWidth, minWidth, remainingMin]
  )

  useEffect(
    () => () => {
      cancelDragRef.current?.()
    },
    []
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0) return
      const root = rootRef.current
      if (!root) return

      event.preventDefault()
      event.stopPropagation()
      const handle = event.currentTarget
      const pointerId = event.pointerId
      const containerWidth = root.parentElement?.clientWidth
      dragRef.current = {
        pointerId,
        startX: event.clientX,
        startW: width,
        containerWidth,
        nextWidth: width,
      }
      handle.setPointerCapture?.(pointerId)
      setActive(true)

      const applyPendingWidth = () => {
        dragFrameRef.current = 0
        const drag = dragRef.current
        const currentRoot = rootRef.current
        if (!drag || !currentRoot) return
        currentRoot.style.width = `${drag.nextWidth}px`
      }

      const scheduleWidthFrame = () => {
        if (dragFrameRef.current !== 0) return
        dragFrameRef.current = window.requestAnimationFrame(applyPendingWidth)
      }

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current
        if (!drag || moveEvent.pointerId !== drag.pointerId) return
        const delta = moveEvent.clientX - drag.startX
        const next = edge === 'start' ? drag.startW - delta : drag.startW + delta
        drag.nextWidth = clampWidth(next, drag.containerWidth)
        scheduleWidthFrame()
      }

      let finished = false
      const finish = (commit: boolean, endEvent?: PointerEvent) => {
        if (finished) return
        const drag = dragRef.current
        if (endEvent && drag && endEvent.pointerId !== drag.pointerId) return
        finished = true
        cancelDragRef.current = null
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
        handle.removeEventListener('lostpointercapture', onEnd)
        if (dragFrameRef.current !== 0) {
          window.cancelAnimationFrame(dragFrameRef.current)
          dragFrameRef.current = 0
        }
        if (drag && rootRef.current) {
          rootRef.current.style.width = `${drag.nextWidth}px`
        }
        dragRef.current = null
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
        endPanelResize('vertical')
        if (commit && drag) {
          setActive(false)
          onWidthChange(drag.nextWidth)
        }
      }
      const onEnd = (endEvent: PointerEvent) => finish(true, endEvent)

      cancelDragRef.current = () => finish(false)
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
      handle.addEventListener('lostpointercapture', onEnd)
      beginPanelResize('vertical', { freezeTerminals: false })
    },
    [clampWidth, edge, onWidthChange, width]
  )

  const borderClass = edge === 'start' ? 'border-l border-border' : 'border-r border-border'
  const panel = (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${borderClass} ${className ?? ''}`}
    >
      {children}
    </div>
  )
  const resizer = (
    <PanelResizer
      orientation="vertical"
      active={active}
      tooltip={tooltip}
      tooltipSide={edge === 'start' ? 'left' : 'right'}
      onPointerDown={onPointerDown}
      ariaValueNow={width}
      ariaValueMin={minWidth}
      ariaValueMax={maxWidth}
    />
  )

  return (
    <div
      ref={rootRef}
      data-scm-resizable-column
      className="flex h-full min-h-0 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      {edge === 'start' ? (
        <>
          {resizer}
          {panel}
        </>
      ) : (
        <>
          {panel}
          {resizer}
        </>
      )}
    </div>
  )
}
