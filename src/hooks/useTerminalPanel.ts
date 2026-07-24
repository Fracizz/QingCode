import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampTerminalWidth,
  getDefaultSideTerminalWidth,
  getTerminalMaxHeight,
  TERMINAL_MIN_HEIGHT,
} from '../lib/panelLayout'
import { PANEL_LAYOUT_CHANGED_EVENT } from '../lib/panelLayoutTemplate'
import { SIDE_WORKSPACE_CHANGED_EVENT } from '../lib/sideWorkspaceLayout'
import { loadSidebarWidth } from '../lib/sidebarLayout'
import {
  beginPanelResize,
  settlePanelResize,
} from '../lib/panelResize'

const TERMINAL_PANEL_KEY = 'qingcode:terminal-panel'

export type SideTerminalSplitMode = 'equal' | 'custom'

function parseSideSplit(value: unknown): SideTerminalSplitMode {
  return value === 'custom' ? 'custom' : 'equal'
}

function loadTerminalPanelState() {
  try {
    const value = JSON.parse(localStorage.getItem(TERMINAL_PANEL_KEY) ?? '{}') as {
      open?: boolean
      height?: number
      width?: number
      sideSplit?: unknown
    }
    const maxH = getTerminalMaxHeight()
    const sideSplit = parseSideSplit(value.sideSplit)
    return {
      open: value.open ?? true,
      height: Math.min(maxH, Math.max(TERMINAL_MIN_HEIGHT, value.height ?? 260)),
      sideSplit,
      width:
        sideSplit === 'custom'
          ? clampTerminalWidth(
              value.width ??
                getDefaultSideTerminalWidth({
                  sidebarVisible: true,
                  sidebarWidth: loadSidebarWidth(),
                }),
            )
          : clampTerminalWidth(
              value.width ??
                getDefaultSideTerminalWidth({
                  sidebarVisible: true,
                  sidebarWidth: loadSidebarWidth(),
                }),
            ),
    }
  } catch {
    return {
      open: true,
      height: 260,
      sideSplit: 'equal' as SideTerminalSplitMode,
      width: getDefaultSideTerminalWidth({
        sidebarVisible: true,
        sidebarWidth: loadSidebarWidth(),
      }),
    }
  }
}

export interface UseTerminalPanelReturn {
  terminalOpen: boolean
  setTerminalOpen: React.Dispatch<React.SetStateAction<boolean>>
  terminalHeight: number
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>
  terminalWidth: number
  setTerminalWidth: React.Dispatch<React.SetStateAction<number>>
  sideSplit: SideTerminalSplitMode
  setSideSplit: React.Dispatch<React.SetStateAction<SideTerminalSplitMode>>
  isTerminalResizing: boolean
  dragHeightRef: React.MutableRefObject<number>
  dragWidthRef: React.MutableRefObject<number>
  onResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onWidthResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  terminalPanelRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Pointer Capture 拖动：每帧只应用最新像素尺寸，字符网格由终端独立调度。
 */
export function useTerminalPanel(): UseTerminalPanelReturn {
  const [initialTerminalPanel] = useState(loadTerminalPanelState)
  const [terminalOpen, setTerminalOpen] = useState(initialTerminalPanel.open)
  const [terminalHeight, setTerminalHeight] = useState(initialTerminalPanel.height)
  const [terminalWidth, setTerminalWidth] = useState(initialTerminalPanel.width)
  const [sideSplit, setSideSplit] = useState<SideTerminalSplitMode>(initialTerminalPanel.sideSplit)
  const [isTerminalResizing, setIsTerminalResizing] = useState(false)
  const terminalPanelRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null)
  const widthDragStateRef = useRef<{ startX: number; startW: number } | null>(null)
  const dragHeightRef = useRef(terminalHeight)
  const dragWidthRef = useRef(terminalWidth)
  const sideSplitRef = useRef(sideSplit)
  const targetSizeRef = useRef(0)
  const lastAppliedPxRef = useRef(0)
  const sizeRafRef = useRef(0)

  useEffect(() => {
    dragHeightRef.current = terminalHeight
  }, [terminalHeight])

  useEffect(() => {
    dragWidthRef.current = terminalWidth
  }, [terminalWidth])

  useEffect(() => {
    sideSplitRef.current = sideSplit
  }, [sideSplit])

  useEffect(() => {
    const onLayoutChange = (event: Event) => {
      const template = (event as CustomEvent<{ template?: string }>).detail?.template
      if (template === 'sideTerminal') setSideSplit('equal')
    }
    const onWorkspaceChange = (event: Event) => {
      const columns = (
        event as CustomEvent<{
          columns?: { editorVisible?: boolean; dualTerminal?: boolean; quadTerminal?: boolean }
        }>
      ).detail?.columns
      // Equal split restores 1:1 (single) or 1:1:1 (dual/田+editor via CSS 2:1 band).
      if (columns?.editorVisible || columns?.dualTerminal || columns?.quadTerminal) {
        setSideSplit('equal')
      }
    }
    window.addEventListener(PANEL_LAYOUT_CHANGED_EVENT, onLayoutChange)
    window.addEventListener(SIDE_WORKSPACE_CHANGED_EVENT, onWorkspaceChange)
    return () => {
      window.removeEventListener(PANEL_LAYOUT_CHANGED_EVENT, onLayoutChange)
      window.removeEventListener(SIDE_WORKSPACE_CHANGED_EVENT, onWorkspaceChange)
    }
  }, [])

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

      // 每帧读取一次最新目标，丢弃同一帧内的中间 pointermove。
      const px = Math.round(targetSizeRef.current)
      if (px !== lastAppliedPxRef.current) {
        lastAppliedPxRef.current = px
        if (orientation === 'horizontal') {
          dragHeightRef.current = px
          dock.style.height = `${px}px`
        } else {
          dragWidthRef.current = px
          dock.style.width = `${px}px`
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
      targetSizeRef.current = startH
      lastAppliedPxRef.current = startH
      setIsTerminalResizing(true)
      beginPanelResize('horizontal')

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
        cancelSizeFrame()
        const maxH = getTerminalMaxHeight()
        const next = Math.min(
          maxH,
          Math.max(TERMINAL_MIN_HEIGHT, Math.round(targetSizeRef.current))
        )
        dragHeightRef.current = next
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

      let startW = dragWidthRef.current
      if (sideSplitRef.current === 'equal') {
        startW = Math.round(dock.getBoundingClientRect().width)
        dragWidthRef.current = startW
        setTerminalWidth(startW)
        setSideSplit('custom')
        sideSplitRef.current = 'custom'
      }

      widthDragStateRef.current = { startX: e.clientX, startW }
      targetSizeRef.current = startW
      lastAppliedPxRef.current = startW
      setIsTerminalResizing(true)
      beginPanelResize('vertical')

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
        cancelSizeFrame()
        const next = clampTerminalWidth(Math.round(targetSizeRef.current))
        dragWidthRef.current = next
        dock.style.width = `${next}px`
        setTerminalWidth(next)
        setSideSplit('custom')
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
        sideSplit,
      })
    )
  }, [terminalOpen, terminalHeight, terminalWidth, sideSplit])

  useEffect(() => {
    const onResize = () => {
      if (sideSplitRef.current === 'custom') {
        setTerminalWidth(w => clampTerminalWidth(w))
      }
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
    sideSplit,
    setSideSplit,
    isTerminalResizing,
    dragHeightRef,
    dragWidthRef,
    onResizerPointerDown,
    onWidthResizerPointerDown,
    terminalPanelRef,
  }
}
