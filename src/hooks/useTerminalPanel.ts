import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  clampTerminalWidth,
  getTerminalMaxHeight,
  TERMINAL_DEFAULT_WIDTH,
  TERMINAL_MIN_HEIGHT,
  terminalResizerHint,
  terminalWidthResizerHint,
} from '../lib/panelLayout'
import { beginPanelResize, endPanelResize } from '../lib/panelResize'
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

/**
 * Pin the terminal dock out of flex flow so the editor does not reflow every
 * mousemove (that compositing thrash is a major flicker source in WebView2).
 */
function pinDockBottom(dock: HTMLElement): HTMLDivElement {
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
  return spacer
}

function pinDockSide(dock: HTMLElement): HTMLDivElement {
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
  return spacer
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
  onResizerMouseDown: (e: React.MouseEvent) => void
  onWidthResizerMouseDown: (e: React.MouseEvent) => void
  terminalPanelRef: React.RefObject<HTMLDivElement | null>
}

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

  const onResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const dock = terminalPanelRef.current
    if (!dock) return

    const startH = dragHeightRef.current
    dragStateRef.current = { startY: e.clientY, startH }
    resizeOrientationRef.current = 'horizontal'
    setIsTerminalResizing(true)
    beginPanelResize('horizontal')
    pinDockBottom(dock)
    writeLiveResizeTip(terminalResizerHint(startH, translate))

    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current
      if (!st) return
      const maxH = getTerminalMaxHeight()
      const next = Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, st.startH - (ev.clientY - st.startY)))
      dragHeightRef.current = next
      dock.style.height = `${next}px`
      writeLiveResizeTip(terminalResizerHint(next, translate))
    }
    const onUp = () => {
      dragStateRef.current = null
      resizeOrientationRef.current = null
      const next = dragHeightRef.current
      clearDockOverlay(dock)
      removeSpacer()
      dock.style.height = `${next}px`
      setTerminalHeight(next)
      setIsTerminalResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      requestAnimationFrame(() => {
        endPanelResize('horizontal')
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const onWidthResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const dock = terminalPanelRef.current
    if (!dock) return

    const startW = dragWidthRef.current
    widthDragStateRef.current = { startX: e.clientX, startW }
    resizeOrientationRef.current = 'vertical'
    setIsTerminalResizing(true)
    beginPanelResize('vertical')
    pinDockSide(dock)
    writeLiveResizeTip(terminalWidthResizerHint(startW, translate))

    const onMove = (ev: MouseEvent) => {
      const st = widthDragStateRef.current
      if (!st) return
      const next = clampTerminalWidth(st.startW + (ev.clientX - st.startX))
      dragWidthRef.current = next
      dock.style.width = `${next}px`
      writeLiveResizeTip(terminalWidthResizerHint(next, translate))
    }
    const onUp = () => {
      widthDragStateRef.current = null
      resizeOrientationRef.current = null
      const next = dragWidthRef.current
      clearDockOverlay(dock)
      removeSpacer()
      dock.style.width = `${next}px`
      setTerminalWidth(next)
      setIsTerminalResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      requestAnimationFrame(() => {
        endPanelResize('vertical')
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

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
    onResizerMouseDown,
    onWidthResizerMouseDown,
    terminalPanelRef,
  }
}
