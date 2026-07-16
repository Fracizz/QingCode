import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

const OFFSET = 8
const SHOW_DELAY = 400

function getPosition(rect: DOMRect, side: TooltipSide): CSSProperties {
  switch (side) {
    case 'right':
      return {
        left: rect.right + OFFSET,
        top: rect.top + rect.height / 2,
        transform: 'translateY(-50%)',
      }
    case 'left':
      return {
        left: rect.left - OFFSET,
        top: rect.top + rect.height / 2,
        transform: 'translate(-100%, -50%)',
      }
    case 'top':
      return {
        left: rect.left + rect.width / 2,
        top: rect.top - OFFSET,
        transform: 'translate(-50%, -100%)',
      }
    case 'bottom':
      return {
        left: rect.left + rect.width / 2,
        top: rect.bottom + OFFSET,
        transform: 'translateX(-50%)',
      }
  }
}

interface Props {
  label: string
  side?: TooltipSide
  delay?: number
  wrapperClassName?: string
  children: ReactNode
}

export default function Tooltip({
  label,
  side = 'right',
  delay = SHOW_DELAY,
  wrapperClassName = 'inline-flex',
  children,
}: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const timerRef = useRef<number | undefined>(undefined)

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setStyle(getPosition(rect, side))
  }

  const scheduleShow = () => {
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      updatePosition()
      setOpen(true)
    }, delay)
  }

  const hide = () => {
    clearTimer()
    setOpen(false)
  }

  useEffect(() => () => clearTimer(), [])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const onLayoutChange = () => updatePosition()
    window.addEventListener('scroll', onLayoutChange, true)
    window.addEventListener('resize', onLayoutChange)
    return () => {
      window.removeEventListener('scroll', onLayoutChange, true)
      window.removeEventListener('resize', onLayoutChange)
    }
  }, [open, side])

  return (
    <>
      <span
        ref={triggerRef}
        className={wrapperClassName}
        onMouseEnter={scheduleShow}
        onMouseLeave={hide}
        onFocus={scheduleShow}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            role="tooltip"
            className="fixed z-[100] pointer-events-none rounded px-2 py-1 text-[11px] leading-4 text-fg border border-border-strong bg-bg-elevated shadow-lg shadow-black/40 whitespace-nowrap"
            style={{ ...style, fontSize: 'var(--ui-font-size)' }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
