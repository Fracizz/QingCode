import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getTerminalMaxHeight,
  TERMINAL_MIN_HEIGHT,
} from '../lib/panelLayout'
import { beginPanelResize, endPanelResize } from '../lib/panelResize'

const TERMINAL_PANEL_KEY = 'qingcode:terminal-panel'

function loadTerminalPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(TERMINAL_PANEL_KEY) ?? '{}') as {
      open?: boolean
      height?: number
    }
    const maxH = getTerminalMaxHeight()
    return {
      open: value.open ?? true,
      height: Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, value.height ?? 260)),
    }
  } catch {
    return { open: true, height: 260 }
  }
}

export interface UseTerminalPanelReturn {
  terminalOpen: boolean
  setTerminalOpen: React.Dispatch<React.SetStateAction<boolean>>
  terminalHeight: number
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>
  isTerminalResizing: boolean
  onResizerMouseDown: (e: React.MouseEvent) => void
  terminalPanelRef: React.RefObject<HTMLDivElement | null>
}

export function useTerminalPanel(): UseTerminalPanelReturn {
  const initialTerminalPanel = useRef(loadTerminalPanelState()).current
  const [terminalOpen, setTerminalOpen] = useState(initialTerminalPanel.open)
  const [terminalHeight, setTerminalHeight] = useState(initialTerminalPanel.height)
  const [isTerminalResizing, setIsTerminalResizing] = useState(false)
  const terminalPanelRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null)
  const dragHeightRef = useRef(terminalHeight)

  useEffect(() => {
    dragHeightRef.current = terminalHeight
  }, [terminalHeight])

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

  useEffect(() => {
    localStorage.setItem(
      TERMINAL_PANEL_KEY,
      JSON.stringify({ open: terminalOpen, height: terminalHeight })
    )
  }, [terminalOpen, terminalHeight])

  return {
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
    setTerminalHeight,
    isTerminalResizing,
    onResizerMouseDown,
    terminalPanelRef,
  }
}
