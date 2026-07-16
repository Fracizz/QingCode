import { useCallback, useRef, useState, type ReactNode } from 'react'
import PanelResizer from './PanelResizer'
import {
  clampSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../lib/sidebarLayout'
import { sidebarResizerHint } from '../lib/panelLayout'

interface Props {
  width: number
  onWidthChange: (width: number) => void
  children: ReactNode
  className?: string
}

export default function ResizableSidebar({ width, onWidthChange, children, className }: Props) {
  const [active, setActive] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      setActive(true)

      const onMove = (ev: MouseEvent) => {
        const st = dragRef.current
        if (!st) return
        onWidthChange(clampSidebarWidth(st.startW + (ev.clientX - st.startX)))
      }

      const onUp = () => {
        dragRef.current = null
        setActive(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [width, onWidthChange]
  )

  return (
    <div className="flex flex-shrink-0 h-full overflow-hidden" style={{ width }}>
      <div className={`flex-1 min-w-0 flex flex-col overflow-hidden border-r border-border ${className ?? ''}`}>
        {children}
      </div>
      <PanelResizer
        orientation="vertical"
        active={active}
        tooltip={sidebarResizerHint(width)}
        tooltipSide="right"
        onMouseDown={onMouseDown}
        ariaValueNow={width}
        ariaValueMin={SIDEBAR_MIN_WIDTH}
        ariaValueMax={SIDEBAR_MAX_WIDTH}
      />
    </div>
  )
}
