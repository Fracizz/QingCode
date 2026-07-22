import { useCallback, useRef, useState, type ReactNode } from 'react'
import PanelResizer from './PanelResizer'
import { beginPanelResize, endPanelResize } from '../lib/panelResize'

type Props = {
  width: number
  minWidth: number
  maxWidth: number
  /** Leave at least this many px for content to the right of the resizer. */
  remainingMin?: number
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
        onWidthChange(clampWidth(st.startW + (ev.clientX - st.startX), parentWidth))
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
    [clampWidth, onWidthChange, width],
  )

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-shrink-0 overflow-hidden"
      style={{ width }}
    >
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-border ${className ?? ''}`}
      >
        {children}
      </div>
      <PanelResizer
        orientation="vertical"
        active={active}
        tooltip={tooltip}
        tooltipSide="right"
        onMouseDown={onMouseDown}
        ariaValueNow={width}
        ariaValueMin={minWidth}
        ariaValueMax={maxWidth}
      />
    </div>
  )
}
