import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampTerminalWidth,
  getTerminalMaxHeight,
  TERMINAL_DEFAULT_WIDTH,
  TERMINAL_MIN_HEIGHT,
} from '../lib/panelLayout'
import { beginPanelResize, endPanelResize } from '../lib/panelResize'

const TERMINAL_PANEL_KEY = 'qingcode:terminal-panel'

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

export interface UseTerminalPanelReturn {
  terminalOpen: boolean
  setTerminalOpen: React.Dispatch<React.SetStateAction<boolean>>
  terminalHeight: number
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>
  terminalWidth: number
  setTerminalWidth: React.Dispatch<React.SetStateAction<number>>
  isTerminalResizing: boolean
  /** Live drag size — share with TerminalPanel so mid-drag re-renders do not snap back. */
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

  useEffect(() => {
    dragHeightRef.current = terminalHeight
  }, [terminalHeight])

  useEffect(() => {
    dragWidthRef.current = terminalWidth
  }, [terminalWidth])

  const onResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startH = dragHeightRef.current
    dragStateRef.current = { startY: e.clientY, startH }
    setIsTerminalResizing(true)
    beginPanelResize('horizontal')

    // Drive height via DOM during drag to avoid re-rendering App/Editor/xterm every pixel.
    // React state + localStorage commit on mouseup.
    const panel = terminalPanelRef.current
    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current
      if (!st) return
      const maxH = getTerminalMaxHeight()
      const next = Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, st.startH - (ev.clientY - st.startY)))
      dragHeightRef.current = next
      if (panel) panel.style.height = `${next}px`
    }
    const onUp = () => {
      dragStateRef.current = null
      setTerminalHeight(dragHeightRef.current)
      setIsTerminalResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      endPanelResize('horizontal')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const onWidthResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startW = dragWidthRef.current
    widthDragStateRef.current = { startX: e.clientX, startW }
    setIsTerminalResizing(true)
    beginPanelResize('vertical')

    const panel = terminalPanelRef.current
    const onMove = (ev: MouseEvent) => {
      const st = widthDragStateRef.current
      if (!st) return
      const next = clampTerminalWidth(st.startW + (ev.clientX - st.startX))
      dragWidthRef.current = next
      if (panel) panel.style.width = `${next}px`
    }
    const onUp = () => {
      widthDragStateRef.current = null
      setTerminalWidth(dragWidthRef.current)
      setIsTerminalResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      endPanelResize('vertical')
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
