import { useCallback, useRef, useState, type ReactNode } from 'react'
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
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const clampWidth = useCallback(
    (next: number, containerWidth?: number) => {
      let safeMax = maxWidth
      if (containerWidth != null && containerWidth > 0) {
        safeMax = Math.min(safeMax, Math.max(minWidth, containerWidth - remainingMin))
      }
      return Math.min(safeMax, Math.max(minWidth, Math.round(next)))
    },
    [maxWidth, minWidth, remainingMin],
  )

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      setActive(true)

      const onMove = (ev: MouseEvent) => {
        const st = dragRef.current
        if (!st) return
        const parentWidth = rootRef.current?.parentElement?.clientWidth
        const delta = ev.clientX - st.startX
        const next = edge === 'start' ? st.startW - delta : st.startW + delta
        onWidthChange(clampWidth(next, parentWidth))
      }

      const onUp = () => {
        dragRef.current = null
        setActive(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        endPanelResize('vertical')
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      beginPanelResize('vertical')
    },
    [clampWidth, edge, onWidthChange, width],
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
      onMouseDown={onMouseDown}
      ariaValueNow={width}
      ariaValueMin={minWidth}
      ariaValueMax={maxWidth}
    />
  )

  return (
    <div
      ref={rootRef}
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
