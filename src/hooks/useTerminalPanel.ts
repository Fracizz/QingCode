import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  clampTerminalWidth,
  getTerminalMaxHeight,
  TERMINAL_DEFAULT_WIDTH,
  TERMINAL_MIN_HEIGHT,
  terminalResizerHint,
  terminalWidthResizerHint,
} from '../lib/panelLayout'
import {
  beginPanelResize,
  resolvePanelResizeSpacerSize,
  settlePanelResize,
} from '../lib/panelResize'
import { translate } from '../lib/i18n'

const TERMINAL_PANEL_KEY = 'qingcode:terminal-panel'
const SPACER_ATTR = 'data-terminal-resize-spacer'

function loadTerminalPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(TERMINAL_PANEL_KEY) ?? '{}') as {
      open?: boolean
      height?: number
      width?: number
    }
    const maxH = getTerminalMaxHeight()
    return {
      open: value.open ?? true,
      height: Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, value.height ?? 260)),
      width: clampTerminalWidth(value.width ?? TERMINAL_DEFAULT_WIDTH),
    }
  } catch {
    return { open: true, height: 260, width: TERMINAL_DEFAULT_WIDTH }
  }
}

function writeLiveResizeTip(text: string) {
  const tip = document.querySelector('[data-panel-resize-live-tip]')
  if (tip) tip.textContent = text
}

function clearDockOverlay(dock: HTMLElement) {
  dock.style.position = ''
  dock.style.left = ''
  dock.style.right = ''
  dock.style.top = ''
  dock.style.bottom = ''
  dock.style.width = ''
  dock.style.height = ''
  dock.style.zIndex = ''
  dock.style.margin = ''
}

/** Overlay terminal growth; released space can still expand the editor. */
function pinDockBottom(dock: HTMLElement) {
  const rect = dock.getBoundingClientRect()
  const spacer = document.createElement('div')
  spacer.setAttribute(SPACER_ATTR, 'bottom')
  spacer.style.height = `${rect.height}px`
  spacer.style.flexShrink = '0'
  dock.parentElement?.insertBefore(spacer, dock)

  dock.style.position = 'fixed'
  dock.style.left = `${rect.left}px`
  dock.style.right = `${window.innerWidth - rect.right}px`
  dock.style.bottom = `${window.innerHeight - rect.bottom}px`
  dock.style.height = `${rect.height}px`
  dock.style.zIndex = '40'
  dock.style.width = 'auto'
}

function pinDockSide(dock: HTMLElement) {
  const rect = dock.getBoundingClientRect()
  const spacer = document.createElement('div')
  spacer.setAttribute(SPACER_ATTR, 'side')
  spacer.style.width = `${rect.width}px`
  spacer.style.flexShrink = '0'
  spacer.style.height = '100%'
  dock.parentElement?.insertBefore(spacer, dock)

  dock.style.position = 'fixed'
  dock.style.top = `${rect.top}px`
  dock.style.bottom = `${window.innerHeight - rect.bottom}px`
  dock.style.left = `${rect.left}px`
  dock.style.width = `${rect.width}px`
  dock.style.zIndex = '40'
  dock.style.height = 'auto'
}

function removeSpacer() {
  document.querySelector(`[${SPACER_ATTR}]`)?.remove()
}

export interface UseTerminalPanelReturn {
  terminalOpen: boolean
  setTerminalOpen: React.Dispatch<React.SetStateAction<boolean>>
  terminalHeight: number
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>
  terminalWidth: number
  setTerminalWidth: React.Dispatch<React.SetStateAction<number>>
  isTerminalResizing: boolean
  dragHeightRef: React.MutableRefObject<number>
  dragWidthRef: React.MutableRefObject<number>
  onResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onWidthResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  terminalPanelRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Live sash (keeps flicker low):
 * - ≤1 layout/frame via rAF
 * - latest pointer position without a trailing animation loop
 * - fixed dock overlay; editor only reflows when the terminal shrinks
 * - xterm fit / PTY atomically settled after pointerup
 */
export function useTerminalPanel(): UseTerminalPanelReturn {
  const initialTerminalPanel = useRef(loadTerminalPanelState()).current
  const [terminalOpen, setTerminalOpen] = useState(initialTerminalPanel.open)
  const [terminalHeight, setTerminalHeight] = useState(initialTerminalPanel.height)
  const [terminalWidth, setTerminalWidth] = useState(initialTerminalPanel.width)
  const [isTerminalResizing, setIsTerminalResizing] = useState(false)
  const terminalPanelRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null)
  const widthDragStateRef = useRef<{ startX: number; startW: number } | null>(null)
  const dragHeightRef = useRef(terminalHeight)
  const dragWidthRef = useRef(terminalWidth)
  const resizeOrientationRef = useRef<'horizontal' | 'vertical' | null>(null)
  const targetSizeRef = useRef(0)
  const lastAppliedPxRef = useRef(0)
  const sizeRafRef = useRef(0)

  useEffect(() => {
    dragHeightRef.current = terminalHeight
  }, [terminalHeight])

  useEffect(() => {
    dragWidthRef.current = terminalWidth
  }, [terminalWidth])

  useLayoutEffect(() => {
    if (!isTerminalResizing) return
    const dock = terminalPanelRef.current
    if (!dock || dock.style.position !== 'fixed') return
    if (resizeOrientationRef.current === 'horizontal') {
      dock.style.height = `${dragHeightRef.current}px`
    } else if (resizeOrientationRef.current === 'vertical') {
      dock.style.width = `${dragWidthRef.current}px`
    }
  })

  const cancelSizeFrame = useCallback(() => {
    if (sizeRafRef.current !== 0) {
      window.cancelAnimationFrame(sizeRafRef.current)
      sizeRafRef.current = 0
    }
  }, [])

  const scheduleSizeFrame = useCallback((orientation: 'horizontal' | 'vertical') => {
    if (sizeRafRef.current !== 0) return
    sizeRafRef.current = window.requestAnimationFrame(() => {
      sizeRafRef.current = 0
      const dock = terminalPanelRef.current
      if (!dock) return

      const px = Math.round(targetSizeRef.current)
      if (px !== lastAppliedPxRef.current) {
        lastAppliedPxRef.current = px
        if (orientation === 'horizontal') {
          dragHeightRef.current = px
          dock.style.height = `${px}px`
          const startH = dragStateRef.current?.startH
          const spacer = document.querySelector<HTMLElement>(`[${SPACER_ATTR}="bottom"]`)
          if (startH !== undefined && spacer) {
            spacer.style.height = `${resolvePanelResizeSpacerSize(startH, px)}px`
          }
          writeLiveResizeTip(terminalResizerHint(px, translate))
        } else {
          dragWidthRef.current = px
          dock.style.width = `${px}px`
          const startW = widthDragStateRef.current?.startW
          const spacer = document.querySelector<HTMLElement>(`[${SPACER_ATTR}="side"]`)
          if (startW !== undefined && spacer) {
            spacer.style.width = `${resolvePanelResizeSpacerSize(startW, px)}px`
          }
          writeLiveResizeTip(terminalWidthResizerHint(px, translate))
        }
      }
    })
  }, [])

  const onResizerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.isPrimary || e.button !== 0) return
      e.preventDefault()
      const dock = terminalPanelRef.current
      if (!dock) return
      const handle = e.currentTarget
      const pointerId = e.pointerId
      handle.setPointerCapture(pointerId)

      const startH = dragHeightRef.current
      dragStateRef.current = { startY: e.clientY, startH }
      resizeOrientationRef.current = 'horizontal'
      targetSizeRef.current = startH
      lastAppliedPxRef.current = startH
      setIsTerminalResizing(true)
      beginPanelResize('horizontal')
      pinDockBottom(dock)
      writeLiveResizeTip(terminalResizerHint(startH, translate))

      let finished = false
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        const st = dragStateRef.current
        if (!st) return
        const maxH = getTerminalMaxHeight()
        targetSizeRef.current = Math.min(
          maxH,
          Math.max(TERMINAL_MIN_HEIGHT, st.startH - (ev.clientY - st.startY))
        )
        scheduleSizeFrame('horizontal')
      }
      const cleanup = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
        handle.removeEventListener('lostpointercapture', onLostCapture)
        window.removeEventListener('blur', onBlur)
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      }
      const finish = () => {
        if (finished) return
        finished = true
        cleanup()
        dragStateRef.current = null
        resizeOrientationRef.current = null
        cancelSizeFrame()
        const maxH = getTerminalMaxHeight()
        const next = Math.min(
          maxH,
          Math.max(TERMINAL_MIN_HEIGHT, Math.round(targetSizeRef.current))
        )
        dragHeightRef.current = next
        clearDockOverlay(dock)
        removeSpacer()
        dock.style.height = `${next}px`
        setTerminalHeight(next)
        setIsTerminalResizing(false)
        settlePanelResize('horizontal')
      }
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish()
      }
      const onLostCapture = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish()
      }
      const onBlur = () => finish()
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
      handle.addEventListener('lostpointercapture', onLostCapture)
      window.addEventListener('blur', onBlur)
    },
    [cancelSizeFrame, scheduleSizeFrame]
  )

  const onWidthResizerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.isPrimary || e.button !== 0) return
      e.preventDefault()
      const dock = terminalPanelRef.current
      if (!dock) return
      const handle = e.currentTarget
      const pointerId = e.pointerId
      handle.setPointerCapture(pointerId)

      const startW = dragWidthRef.current
      widthDragStateRef.current = { startX: e.clientX, startW }
      resizeOrientationRef.current = 'vertical'
      targetSizeRef.current = startW
      lastAppliedPxRef.current = startW
      setIsTerminalResizing(true)
      beginPanelResize('vertical')
      pinDockSide(dock)
      writeLiveResizeTip(terminalWidthResizerHint(startW, translate))

      let finished = false
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        const st = widthDragStateRef.current
        if (!st) return
        targetSizeRef.current = clampTerminalWidth(st.startW + (ev.clientX - st.startX))
        scheduleSizeFrame('vertical')
      }
      const cleanup = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
        handle.removeEventListener('lostpointercapture', onLostCapture)
        window.removeEventListener('blur', onBlur)
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      }
      const finish = () => {
        if (finished) return
        finished = true
        cleanup()
        widthDragStateRef.current = null
        resizeOrientationRef.current = null
        cancelSizeFrame()
        const next = clampTerminalWidth(Math.round(targetSizeRef.current))
        dragWidthRef.current = next
        clearDockOverlay(dock)
        removeSpacer()
        dock.style.width = `${next}px`
        setTerminalWidth(next)
        setIsTerminalResizing(false)
        settlePanelResize('vertical')
      }
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish()
      }
      const onLostCapture = (ev: PointerEvent) => {
        if (ev.pointerId === pointerId) finish()
      }
      const onBlur = () => finish()
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
      handle.addEventListener('lostpointercapture', onLostCapture)
      window.addEventListener('blur', onBlur)
    },
    [cancelSizeFrame, scheduleSizeFrame]
  )

  useEffect(() => {
    localStorage.setItem(
      TERMINAL_PANEL_KEY,
      JSON.stringify({
        open: terminalOpen,
        height: terminalHeight,
        width: terminalWidth,
      })
    )
  }, [terminalOpen, terminalHeight, terminalWidth])

  useEffect(() => {
    const onResize = () => {
      setTerminalWidth(w => clampTerminalWidth(w))
      setTerminalHeight(h => {
        const maxH = getTerminalMaxHeight()
        return Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, h))
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return {
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
    setTerminalHeight,
    terminalWidth,
    setTerminalWidth,
    isTerminalResizing,
    dragHeightRef,
    dragWidthRef,
    onResizerPointerDown,
    onWidthResizerPointerDown,
    terminalPanelRef,
  }
}
