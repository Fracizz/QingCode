import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@codemirror/view'
import { setMinimapUpdateHandler } from '../lib/minimapBridge'
import {
  MINIMAP_QUICK_VIEW_DELAY_MS,
  MINIMAP_QUICK_VIEW_GAP,
  MINIMAP_QUICK_VIEW_RADIUS,
  MINIMAP_REPAINT_THROTTLE_MS,
  MINIMAP_SCROLLBAR_WIDTH,
  MINIMAP_WIDTH_DEFAULT,
  MINIMAP_WIDTH_PRESETS,
  clampMinimapWidth,
  loadMinimapHideScrollbar,
  loadMinimapWidth,
  resolveMinimapByteSize,
  resolveMinimapCharSize,
  resolveMinimapContentHeight,
  resolveMinimapLineAtY,
  resolveMinimapMaxWidth,
  resolveMinimapMode,
  resolveMinimapScrollOffset,
  resolveMinimapScrollbarThumb,
  resolveMinimapViewport,
  saveMinimapHideScrollbar,
  saveMinimapWidth,
  type MinimapRenderMode,
} from '../lib/minimapPolicy'

function resolveMinimapMapHeight(root: HTMLElement, view: EditorView): number {
  // Prefer the minimap box, but fall back to the editor pane / scroller so a
  // transient 0-height box during flex layout never blanks the canvas.
  const candidates = [
    root.getBoundingClientRect().height,
    root.parentElement?.getBoundingClientRect().height ?? 0,
    view.scrollDOM.clientHeight,
  ]
  const height = Math.max(0, ...candidates)
  if (height <= 0) return 0
  return Math.min(Math.max(1, Math.round(height)), MINIMAP_CANVAS_MAX_CSS_PX)
}
import {
  collectQuickViewLines,
  MINIMAP_CANVAS_MAX_CSS_PX,
  paintMinimap,
  readMinimapPalette,
} from '../lib/minimapPaint'
import {
  getMinimapEnabled,
  notifyMinimapEnabledChanged,
  saveScopedMinimapEnabled,
} from '../lib/minimapSettings'
import { useProjectStore } from '../store/projectStore'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'
import '../styles/minimap.css'

type Props = {
  viewRef: RefObject<EditorView | null>
  /** Bound tab id — used to reattach after tab switches. */
  tabId: string | null
  fileSize?: number
  /** Notify parent so editor-pane can toggle scrollbar hiding. */
  onHideScrollbarChange?: (hide: boolean) => void
}

type MenuState = {
  x: number
  y: number
}

type QuickViewState = {
  /** Distance from viewport right — anchors panel left of the minimap with a gap. */
  right: number
  y: number
  /** Arrow tip Y inside the panel (px from top). */
  arrowTop: number
  centerLine: number
  startLine: number
  lines: string[]
}

export default function EditorMinimap({
  viewRef,
  tabId,
  fileSize,
  onHideScrollbarChange,
}: Props) {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollbarThumbRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => loadMinimapWidth())
  const [resizing, setResizing] = useState(false)
  const [scrollingThumb, setScrollingThumb] = useState(false)
  const [scrollingViewport, setScrollingViewport] = useState(false)
  const [hideScrollbar, setHideScrollbar] = useState(() => loadMinimapHideScrollbar())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [quickView, setQuickView] = useState<QuickViewState | null>(null)
  const [mode, setMode] = useState<MinimapRenderMode>(() =>
    resolveMinimapMode(resolveMinimapByteSize(fileSize, 0)),
  )
  const widthRef = useRef(width)
  const modeRef = useRef(mode)
  const scheduleRef = useRef(0)
  const repaintFrameRef = useRef(0)
  const viewportFrameRef = useRef(0)
  const lastRepaintAtRef = useRef(0)
  const pendingRepaintRef = useRef(false)
  const resizingRef = useRef(false)
  const quickViewTimerRef = useRef(0)
  const quickViewPendingRef = useRef<{ centerLine: number; clientY: number } | null>(null)
  const dragWidthRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    bodyCursor: string
    bodyUserSelect: string
  } | null>(null)
  const dragScrollRef = useRef<{
    pointerId: number
    startY: number
    startScrollTop: number
    trackHeight: number
    thumbHeight: number
    maxScroll: number
    bodyCursor: string
    bodyUserSelect: string
  } | null>(null)
  /** Canvas / viewport mask drag — delta-based so scrollOffset cannot feedback-loop. */
  const dragViewportRef = useRef<{
    pointerId: number
    startY: number
    startScrollTop: number
    usable: number
    maxScroll: number
    bodyCursor: string
    bodyUserSelect: string
  } | null>(null)

  widthRef.current = width
  modeRef.current = mode

  useEffect(() => {
    onHideScrollbarChange?.(hideScrollbar)
  }, [hideScrollbar, onHideScrollbarChange])

  // Reset tier when switching tabs so a prior >5MB “hidden” state cannot stick.
  useEffect(() => {
    const docLen = viewRef.current?.state.doc.length ?? 0
    const next = resolveMinimapMode(resolveMinimapByteSize(fileSize, docLen))
    modeRef.current = next
    setMode(next)
  }, [tabId, fileSize, viewRef])

  const readScrollMetrics = () => {
    const view = viewRef.current
    const root = rootRef.current
    if (!view || !root) return null
    const scrollDOM = view.scrollDOM
    const mapHeight = resolveMinimapMapHeight(root, view)
    const { charHeight } = resolveMinimapCharSize(modeRef.current)
    const contentHeight = resolveMinimapContentHeight(view.state.doc.lines, charHeight)
    const scrollOffset = resolveMinimapScrollOffset(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      contentHeight,
      mapHeight,
    )
    return {
      view,
      root,
      scrollDOM,
      charHeight,
      contentHeight,
      scrollOffset,
      mapHeight,
    }
  }

  const updateViewportNow = () => {
    const metrics = readScrollMetrics()
    const viewport = viewportRef.current
    const thumb = scrollbarThumbRef.current
    if (!metrics || !viewport) return
    const { scrollDOM, contentHeight, scrollOffset, mapHeight } = metrics
    const { top, height } = resolveMinimapViewport(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      mapHeight,
      contentHeight,
      scrollOffset,
    )
    viewport.style.transform = `translate3d(0, ${top}px, 0)`
    viewport.style.height = `${height}px`

    if (thumb) {
      const rail = resolveMinimapScrollbarThumb(
        scrollDOM.scrollTop,
        scrollDOM.scrollHeight,
        scrollDOM.clientHeight,
        mapHeight,
      )
      thumb.style.transform = `translate3d(0, ${rail.top}px, 0)`
      thumb.style.height = `${rail.height}px`
    }
  }

  const requestViewportUpdate = () => {
    if (viewportFrameRef.current) return
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = 0
      updateViewportNow()
    })
  }

  const repaintNow = () => {
    const view = viewRef.current
    if (!view) return

    const doc = view.state.doc
    const bytes = resolveMinimapByteSize(fileSize, doc.length)
    const nextMode = resolveMinimapMode(bytes)
    if (nextMode !== modeRef.current) {
      modeRef.current = nextMode
      setMode(nextMode)
    }
    if (nextMode === 'hidden') return

    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) {
      requestRepaint(true)
      return
    }

    // Prefer the minimap root (not canvas.clientWidth): paint sets canvas style
    // size explicitly, so a stale canvas width would block drag-resize growth.
    const cssWidth = Math.min(
      Math.max(
        1,
        (root.clientWidth || widthRef.current || MINIMAP_WIDTH_DEFAULT) - MINIMAP_SCROLLBAR_WIDTH,
      ),
      MINIMAP_CANVAS_MAX_CSS_PX,
    )
    const cssHeight = resolveMinimapMapHeight(root, view)
    // Skip when the box has no height yet; the ResizeObserver repaints once
    // flex layout gives it a real size (avoids a per-frame retry spin).
    if (cssHeight <= 0) return

    const head = view.state.selection.main.head
    const caretLine = view.state.doc.lineAt(head).number
    const scrollDOM = view.scrollDOM
    paintMinimap({
      canvas,
      doc,
      state: view.state,
      mode: nextMode,
      cssWidth,
      cssHeight,
      palette: readMinimapPalette(),
      scrollTop: scrollDOM.scrollTop,
      scrollHeight: scrollDOM.scrollHeight,
      clientHeight: scrollDOM.clientHeight,
      caretLine,
    })
    updateViewportNow()
    lastRepaintAtRef.current = performance.now()
  }

  const requestRepaint = (force = false) => {
    // The queued frame reads the latest EditorView state, so another frame would be redundant.
    if (repaintFrameRef.current) return
    pendingRepaintRef.current = true
    if (scheduleRef.current) {
      if (!force) return
      window.clearTimeout(scheduleRef.current)
      scheduleRef.current = 0
    }
    const elapsed = performance.now() - lastRepaintAtRef.current
    const delay = force ? 0 : Math.max(0, MINIMAP_REPAINT_THROTTLE_MS - elapsed)
    scheduleRef.current = window.setTimeout(() => {
      scheduleRef.current = 0
      if (!pendingRepaintRef.current) return
      pendingRepaintRef.current = false
      repaintFrameRef.current = requestAnimationFrame(() => {
        repaintFrameRef.current = 0
        repaintNow()
      })
    }, delay)
  }

  const clearQuickView = () => {
    if (quickViewTimerRef.current) {
      window.clearTimeout(quickViewTimerRef.current)
      quickViewTimerRef.current = 0
    }
    quickViewPendingRef.current = null
    setQuickView(null)
  }

  const showQuickViewAt = (centerLine: number, clientY: number) => {
    const live = viewRef.current
    const root = rootRef.current
    if (!live || !root) return
    const peek = collectQuickViewLines(live.state.doc, centerLine, MINIMAP_QUICK_VIEW_RADIUS)
    const mapLeft = root.getBoundingClientRect().left
    const right = Math.max(8, window.innerWidth - mapLeft + MINIMAP_QUICK_VIEW_GAP)
    const top = Math.min(window.innerHeight - 24, Math.max(8, clientY - 40))
    const arrowTop = Math.min(280, Math.max(14, clientY - top))
    setQuickView({
      right,
      y: top,
      arrowTop,
      centerLine,
      startLine: peek.startLine,
      lines: peek.lines,
    })
  }

  /** Initial hover waits MINIMAP_QUICK_VIEW_DELAY_MS; once visible, track the pointer. */
  const scheduleQuickView = (centerLine: number, clientY: number) => {
    quickViewPendingRef.current = { centerLine, clientY }
    if (quickViewTimerRef.current) return
    quickViewTimerRef.current = window.setTimeout(() => {
      quickViewTimerRef.current = 0
      const pending = quickViewPendingRef.current
      if (!pending) return
      showQuickViewAt(pending.centerLine, pending.clientY)
    }, MINIMAP_QUICK_VIEW_DELAY_MS)
  }

  /** Viewport mask sits above the canvas — Quick View must not show there. */
  const isClientOverViewport = (clientX: number, clientY: number) => {
    const viewport = viewportRef.current
    if (!viewport) return false
    const rect = viewport.getBoundingClientRect()
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    )
  }

  // Attach to CM updates + scroll; retry briefly until view exists after bind.
  useEffect(() => {
    let cancelled = false
    let scrollEl: HTMLElement | null = null
    let tries = 0
    let retryTimer = 0

    const onScroll = () => {
      // Fixed-scale glance must repaint the visible line window while scrolling.
      requestRepaint(true)
    }

    const detachScroll = () => {
      if (scrollEl) {
        scrollEl.removeEventListener('scroll', onScroll)
        scrollEl = null
      }
    }

    const root = rootRef.current
    const pane = root?.parentElement
    const enforceSafeWidth = () => {
      if (!root || !pane || resizingRef.current) return
      const next = clampMinimapWidth(widthRef.current, resolveMinimapMaxWidth(pane.clientWidth))
      if (next === widthRef.current) return
      widthRef.current = next
      root.style.width = `${next}px`
      setWidth(next)
      saveMinimapWidth(next)
    }
    const ro =
      root && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (resizingRef.current) return
            enforceSafeWidth()
            requestRepaint(true)
          })
        : null
    if (root && ro) ro.observe(root)
    if (pane && ro) ro.observe(pane)

    const attach = () => {
      if (cancelled) return
      const view = viewRef.current
      if (!view) {
        if (tries++ < 40) {
          retryTimer = window.setTimeout(attach, 16)
        }
        return
      }
      detachScroll()
      scrollEl = view.scrollDOM
      scrollEl.addEventListener('scroll', onScroll, { passive: true })
      if (ro) ro.observe(scrollEl)
      // WebView2 can settle flex layout a frame or two late; repaint across a few
      // ticks so the first paint never lands on a 0-height (blank) canvas.
      requestAnimationFrame(() => {
        if (cancelled) return
        requestRepaint(true)
        requestAnimationFrame(() => {
          if (!cancelled) requestRepaint(true)
        })
      })
      window.setTimeout(() => {
        if (!cancelled) requestRepaint(true)
      }, 120)
    }

    setMinimapUpdateHandler(update => {
      if (update.docChanged) requestRepaint(false)
      if (update.selectionSet) requestRepaint(false)
      if (update.geometryChanged) {
        requestViewportUpdate()
        requestRepaint(true)
      }
    })

    attach()
    enforceSafeWidth()

    const onTheme = () => requestRepaint(true)
    window.addEventListener('qingcode:theme-changed', onTheme)

    return () => {
      cancelled = true
      const drag = dragWidthRef.current
      if (drag) {
        document.body.style.cursor = drag.bodyCursor
        document.body.style.userSelect = drag.bodyUserSelect
        dragWidthRef.current = null
        resizingRef.current = false
      }
      const scrollDrag = dragScrollRef.current
      if (scrollDrag) {
        document.body.style.cursor = scrollDrag.bodyCursor
        document.body.style.userSelect = scrollDrag.bodyUserSelect
        dragScrollRef.current = null
      }
      const viewportDrag = dragViewportRef.current
      if (viewportDrag) {
        document.body.style.cursor = viewportDrag.bodyCursor
        document.body.style.userSelect = viewportDrag.bodyUserSelect
        dragViewportRef.current = null
        setScrollingViewport(false)
      }
      window.clearTimeout(retryTimer)
      if (scheduleRef.current) {
        window.clearTimeout(scheduleRef.current)
        scheduleRef.current = 0
      }
      if (repaintFrameRef.current) {
        cancelAnimationFrame(repaintFrameRef.current)
        repaintFrameRef.current = 0
      }
      if (viewportFrameRef.current) {
        cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = 0
      }
      clearQuickView()
      setMinimapUpdateHandler(null)
      detachScroll()
      ro?.disconnect()
      window.removeEventListener('qingcode:theme-changed', onTheme)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, fileSize, viewRef])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /** Place the viewport so its center tracks `clientY` (scrollbar-thumb mapping). */
  const jumpToClientY = (clientY: number) => {
    const metrics = readScrollMetrics()
    if (!metrics) return
    const { root, scrollDOM, contentHeight, scrollOffset, mapHeight } = metrics
    const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight)
    if (maxScroll <= 0) return
    const canvas = canvasRef.current
    const rect = (canvas ?? root).getBoundingClientRect()
    const { height: vpHeight } = resolveMinimapViewport(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      mapHeight,
      contentHeight,
      scrollOffset,
    )
    const usable = Math.max(1, mapHeight - vpHeight)
    const ratio = Math.min(
      1,
      Math.max(0, (clientY - rect.top - vpHeight / 2) / usable),
    )
    scrollDOM.scrollTop = ratio * maxScroll
  }

  const beginViewportDrag = (
    event: ReactPointerEvent<HTMLElement>,
    options: { jump: boolean },
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    clearQuickView()
    setMenu(null)

    if (options.jump) jumpToClientY(event.clientY)

    const metrics = readScrollMetrics()
    if (!metrics) return
    const { scrollDOM, contentHeight, scrollOffset, mapHeight } = metrics
    const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight)
    const { height: vpHeight } = resolveMinimapViewport(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      mapHeight,
      contentHeight,
      scrollOffset,
    )

    event.currentTarget.setPointerCapture(event.pointerId)
    dragViewportRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollDOM.scrollTop,
      usable: Math.max(1, mapHeight - vpHeight),
      maxScroll,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    }
    setScrollingThumb(true)
    setScrollingViewport(true)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  const onViewportPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragViewportRef.current
    const metrics = readScrollMetrics()
    if (!drag || drag.pointerId !== event.pointerId || !metrics) return
    if (drag.maxScroll <= 0) return
    const deltaRatio = (event.clientY - drag.startY) / drag.usable
    metrics.scrollDOM.scrollTop = Math.min(
      drag.maxScroll,
      Math.max(0, drag.startScrollTop + deltaRatio * drag.maxScroll),
    )
    // Scroll listener repaints; keep the mask tight to the pointer this frame.
    updateViewportNow()
  }

  const finishViewportDrag = (target: HTMLElement, pointerId: number) => {
    const drag = dragViewportRef.current
    if (!drag || drag.pointerId !== pointerId) return
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    dragViewportRef.current = null
    document.body.style.cursor = drag.bodyCursor
    document.body.style.userSelect = drag.bodyUserSelect
    setScrollingThumb(false)
    setScrollingViewport(false)
    requestRepaint(true)
  }

  const scrollToTrackY = (clientY: number, track: DOMRect, thumbHeight: number) => {
    const metrics = readScrollMetrics()
    if (!metrics) return
    const { scrollDOM } = metrics
    const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight)
    if (maxScroll === 0) return
    const usable = Math.max(1, track.height - thumbHeight)
    const ratio = Math.min(1, Math.max(0, (clientY - track.top - thumbHeight / 2) / usable))
    scrollDOM.scrollTop = ratio * maxScroll
    requestRepaint(true)
  }

  const onScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    clearQuickView()
    setMenu(null)

    const metrics = readScrollMetrics()
    const thumb = scrollbarThumbRef.current
    if (!metrics || !thumb) return
    const { scrollDOM, mapHeight } = metrics
    const rail = resolveMinimapScrollbarThumb(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      mapHeight,
    )
    const track = event.currentTarget.getBoundingClientRect()
    const onThumb = (event.target as HTMLElement).closest('.editor-minimap__scrollbar-thumb')

    if (!onThumb) {
      scrollToTrackY(event.clientY, track, rail.height)
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    dragScrollRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollDOM.scrollTop,
      trackHeight: mapHeight,
      thumbHeight: rail.height,
      maxScroll: Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight),
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    }
    setScrollingThumb(true)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  const onScrollbarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragScrollRef.current
    const metrics = readScrollMetrics()
    if (!drag || drag.pointerId !== event.pointerId || !metrics) return
    if (drag.maxScroll <= 0) return
    const usable = Math.max(1, drag.trackHeight - drag.thumbHeight)
    const deltaRatio = (event.clientY - drag.startY) / usable
    metrics.scrollDOM.scrollTop = Math.min(
      drag.maxScroll,
      Math.max(0, drag.startScrollTop + deltaRatio * drag.maxScroll),
    )
    requestRepaint(true)
  }

  const finishScrollbarDrag = (target: HTMLElement, pointerId: number) => {
    const drag = dragScrollRef.current
    if (!drag || drag.pointerId !== pointerId) return
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    dragScrollRef.current = null
    document.body.style.cursor = drag.bodyCursor
    document.body.style.userSelect = drag.bodyUserSelect
    setScrollingThumb(false)
  }

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    beginViewportDrag(event, { jump: true })
  }

  const onCanvasContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    clearQuickView()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const onCanvasMouseMove = (event: ReactMouseEvent) => {
    if (menu || resizingRef.current || dragViewportRef.current || dragScrollRef.current) return
    if (isClientOverViewport(event.clientX, event.clientY)) {
      clearQuickView()
      return
    }
    const metrics = readScrollMetrics()
    if (!metrics) return
    const { view, charHeight, scrollOffset } = metrics
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const offsetY = event.clientY - rect.top
    const centerLine = resolveMinimapLineAtY(
      offsetY,
      charHeight,
      scrollOffset,
      view.state.doc.lines,
    )
    const clientY = event.clientY

    if (quickView) {
      showQuickViewAt(centerLine, clientY)
    } else {
      scheduleQuickView(centerLine, clientY)
    }
  }

  const finishResize = (target: HTMLElement, pointerId: number) => {
    const drag = dragWidthRef.current
    if (!drag || drag.pointerId !== pointerId) return
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    dragWidthRef.current = null
    resizingRef.current = false
    document.body.style.cursor = drag.bodyCursor
    document.body.style.userSelect = drag.bodyUserSelect
    setResizing(false)
    setWidth(widthRef.current)
    saveMinimapWidth(widthRef.current)
    requestRepaint(true)
  }

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    clearQuickView()
    setMenu(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    dragWidthRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    }
    resizingRef.current = true
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragWidthRef.current
    const root = rootRef.current
    const pane = root?.parentElement
    if (!drag || drag.pointerId !== event.pointerId || !root || !pane) return
    const maxWidth = resolveMinimapMaxWidth(pane.clientWidth)
    // Dragging the left edge left makes the minimap wider; right makes it narrower.
    const next = clampMinimapWidth(drag.startWidth + (drag.startX - event.clientX), maxWidth)
    if (next === widthRef.current) return
    widthRef.current = next
    // Stretch the existing bitmap while dragging; repaint once on release.
    root.style.width = `${next}px`
  }

  const applyWidthPreset = (preset: number) => {
    const root = rootRef.current
    const pane = root?.parentElement
    const maxWidth = pane ? resolveMinimapMaxWidth(pane.clientWidth) : undefined
    const next = clampMinimapWidth(preset, maxWidth)
    widthRef.current = next
    if (root) root.style.width = `${next}px`
    setWidth(next)
    saveMinimapWidth(next)
    setMenu(null)
    requestRepaint(true)
  }

  const toggleEnabled = async () => {
    setMenu(null)
    const next = !getMinimapEnabled()
    notifyMinimapEnabledChanged(next)
    try {
      await saveScopedMinimapEnabled('global', next, currentProject)
    } catch {
      notifyMinimapEnabledChanged(!next)
    }
  }

  const toggleHideScrollbar = () => {
    const next = !hideScrollbar
    setHideScrollbar(next)
    saveMinimapHideScrollbar(next)
    setMenu(null)
  }

  if (mode === 'hidden') return null

  const resizeHint = t('左右拖拽调整小地图宽度')

  return (
    <>
      <div
        ref={rootRef}
        className={`editor-minimap${resizing ? ' editor-minimap--resizing' : ''}${
          scrollingThumb ? ' editor-minimap--scrolling' : ''
        }`}
        style={{ width }}
        aria-hidden
        onMouseLeave={clearQuickView}
      >
        <div
          className="editor-minimap__scrollbar"
          onPointerDown={onScrollbarPointerDown}
          onPointerMove={onScrollbarPointerMove}
          onPointerUp={event => finishScrollbarDrag(event.currentTarget, event.pointerId)}
          onPointerCancel={event => finishScrollbarDrag(event.currentTarget, event.pointerId)}
          aria-label={t('拖拽滚动')}
        >
          <div ref={scrollbarThumbRef} className="editor-minimap__scrollbar-thumb" />
        </div>
        <Tooltip
          label={resizeHint}
          side="left"
          delay={280}
          wrapperClassName="editor-minimap__resizer-tip"
        >
          <div
            className="editor-minimap__resizer"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={event => finishResize(event.currentTarget, event.pointerId)}
            onPointerCancel={event => finishResize(event.currentTarget, event.pointerId)}
            aria-label={resizeHint}
          />
        </Tooltip>
        <canvas
          ref={canvasRef}
          className="editor-minimap__canvas"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={event => finishViewportDrag(event.currentTarget, event.pointerId)}
          onPointerCancel={event => finishViewportDrag(event.currentTarget, event.pointerId)}
          onContextMenu={onCanvasContextMenu}
          onMouseMove={onCanvasMouseMove}
          onMouseLeave={clearQuickView}
        />
        <div
          ref={viewportRef}
          className={`editor-minimap__viewport${
            scrollingViewport ? ' editor-minimap__viewport--active' : ''
          }`}
          onPointerDown={event => beginViewportDrag(event, { jump: false })}
          onPointerMove={onViewportPointerMove}
          onPointerUp={event => finishViewportDrag(event.currentTarget, event.pointerId)}
          onPointerCancel={event => finishViewportDrag(event.currentTarget, event.pointerId)}
          onMouseEnter={clearQuickView}
          onMouseMove={clearQuickView}
        />
      </div>
      {quickView &&
        createPortal(
          <div
            className="editor-minimap__quick-view"
            style={
              {
                right: quickView.right,
                top: quickView.y,
                '--minimap-qv-arrow-top': `${quickView.arrowTop}px`,
              } as CSSProperties
            }
          >
            <div className="editor-minimap__quick-view-body">
              {quickView.lines.map((line, index) => {
                const lineNumber = quickView.startLine + index
                const isCenter = lineNumber === quickView.centerLine
                return (
                  <div
                    key={lineNumber}
                    className={`editor-minimap__quick-view-line${
                      isCenter ? ' editor-minimap__quick-view-line--center' : ''
                    }`}
                  >
                    <span className="editor-minimap__quick-view-gutter">{lineNumber}</span>
                    <span className="editor-minimap__quick-view-code">{line || ' '}</span>
                  </div>
                )
              })}
            </div>
          </div>,
          document.body,
        )}
      {menu &&
        createPortal(
          <div
            className="editor-minimap__menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={event => event.stopPropagation()}
          >
            <button type="button" className="editor-minimap__menu-item" onClick={() => void toggleEnabled()}>
              {t('关闭小地图')}
            </button>
            <div className="editor-minimap__menu-sep" />
            {MINIMAP_WIDTH_PRESETS.map(preset => (
              <button
                key={preset}
                type="button"
                className={`editor-minimap__menu-item${
                  width === preset ? ' editor-minimap__menu-item--active' : ''
                }`}
                onClick={() => applyWidthPreset(preset)}
              >
                {t('宽度 {n}px', { n: preset })}
              </button>
            ))}
            <div className="editor-minimap__menu-sep" />
            <button
              type="button"
              className={`editor-minimap__menu-check${
                hideScrollbar ? ' editor-minimap__menu-check--on' : ''
              }`}
              onClick={toggleHideScrollbar}
            >
              {t('隐藏编辑器滚动条')}
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
