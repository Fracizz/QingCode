import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import type { EditorView } from '@codemirror/view'
import type { Text } from '@codemirror/state'
import { setMinimapUpdateHandler } from '../lib/minimapBridge'
import {
  MINIMAP_REPAINT_THROTTLE_MS,
  MINIMAP_WIDTH_DEFAULT,
  clampMinimapWidth,
  loadMinimapWidth,
  resolveMinimapByteSize,
  resolveMinimapMaxWidth,
  resolveMinimapMode,
  resolveMinimapViewport,
  saveMinimapWidth,
  type MinimapRenderMode,
} from '../lib/minimapPolicy'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'
import '../styles/minimap.css'

type Props = {
  viewRef: RefObject<EditorView | null>
  /** Bound tab id — used to reattach after tab switches. */
  tabId: string | null
  fileSize?: number
}

type LineKind = 'empty' | 'comment' | 'string' | 'keyword' | 'code'

const KEYWORD_RE =
  /^(import|export|from|function|const|let|var|class|return|if|else|for|while|switch|case|break|continue|type|interface|enum|async|await|def|class|public|private|protected|struct|fn|use|mod|impl|pub|package|func)\b/

function classifyLine(text: string): LineKind {
  const t = text.trimStart()
  if (!t) return 'empty'
  if (
    t.startsWith('//') ||
    t.startsWith('#') ||
    t.startsWith('/*') ||
    t.startsWith('*') ||
    t.startsWith('<!--')
  ) {
    return 'comment'
  }
  if (t.startsWith('"') || t.startsWith("'") || t.startsWith('`')) return 'string'
  if (KEYWORD_RE.test(t)) return 'keyword'
  return 'code'
}

function readThemeColors() {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => {
    const v = styles.getPropertyValue(name).trim()
    return v || fallback
  }
  return {
    code: read('--color-fg-muted', '#858585'),
    comment: read('--color-fg-dim', '#6b6b6b'),
    string: read('--color-ok', '#89d185'),
    keyword: read('--color-accent', '#4d9eff'),
    density: read('--color-fg-dim', '#6b6b6b'),
  }
}

function colorForKind(kind: LineKind, colors: ReturnType<typeof readThemeColors>): string {
  switch (kind) {
    case 'comment':
      return colors.comment
    case 'string':
      return colors.string
    case 'keyword':
      return colors.keyword
    case 'empty':
      return 'transparent'
    default:
      return colors.code
  }
}

/** Dense first-version look: one sample per canvas row keeps structure readable. */
function paintMinimap(
  canvas: HTMLCanvasElement,
  doc: Text,
  mode: MinimapRenderMode,
  cssWidth: number,
  cssHeight: number,
) {
  if (mode === 'hidden' || cssWidth <= 0 || cssHeight <= 0) return

  const dpr = mode === 'density' ? 1 : Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.floor(cssWidth * dpr))
  const h = Math.max(1, Math.floor(cssHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const totalLines = Math.max(1, doc.lines)
  const colors = readThemeColors()
  const sampleRows = Math.max(1, Math.floor(cssHeight))

  for (let y = 0; y < sampleRows; y++) {
    const lineNum = Math.min(totalLines, Math.floor((y / sampleRows) * totalLines) + 1)
    let lineText = ''
    let lineLen = 0
    try {
      const line = doc.line(lineNum)
      lineLen = line.length
      if (mode === 'full') {
        // Sample a short prefix only — never materialize the whole document.
        lineText = doc.sliceString(line.from, Math.min(line.to, line.from + 96))
      }
    } catch {
      continue
    }

    if (mode === 'density') {
      const density = Math.min(1, lineLen / 100)
      if (density <= 0) continue
      ctx.fillStyle = colors.density
      ctx.globalAlpha = 0.35 + density * 0.55
      ctx.fillRect(0, y, Math.max(1, cssWidth * density), 1)
      ctx.globalAlpha = 1
      continue
    }

    const kind = classifyLine(lineText)
    if (kind === 'empty') continue
    const bar = Math.min(1, Math.max(0.12, lineLen / 80))
    ctx.fillStyle = colorForKind(kind, colors)
    ctx.fillRect(0, y, Math.max(1, cssWidth * bar), 1)
  }
}

export default function EditorMinimap({ viewRef, tabId, fileSize }: Props) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(() => loadMinimapWidth())
  const [resizing, setResizing] = useState(false)
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
  const dragWidthRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    bodyCursor: string
    bodyUserSelect: string
  } | null>(null)

  widthRef.current = width
  modeRef.current = mode

  // Reset tier when switching tabs so a prior >5MB “hidden” state cannot stick.
  useEffect(() => {
    const docLen = viewRef.current?.state.doc.length ?? 0
    const next = resolveMinimapMode(resolveMinimapByteSize(fileSize, docLen))
    modeRef.current = next
    setMode(next)
  }, [tabId, fileSize, viewRef])

  const updateViewportNow = () => {
    const view = viewRef.current
    const viewport = viewportRef.current
    const root = rootRef.current
    if (!view || !viewport || !root) return
    const scrollDOM = view.scrollDOM
    const { top, height } = resolveMinimapViewport(
      scrollDOM.scrollTop,
      scrollDOM.scrollHeight,
      scrollDOM.clientHeight,
      root.clientHeight,
    )
    viewport.style.transform = `translate3d(0, ${top}px, 0)`
    viewport.style.height = `${height}px`
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

    const cssWidth = root.clientWidth || widthRef.current || MINIMAP_WIDTH_DEFAULT
    const cssHeight = root.clientHeight
    if (cssHeight <= 0) return

    paintMinimap(canvas, doc, nextMode, cssWidth, cssHeight)
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

  // Attach to CM updates + scroll; retry briefly until view exists after bind.
  useEffect(() => {
    let cancelled = false
    let scrollEl: HTMLElement | null = null
    let tries = 0
    let retryTimer = 0

    const detachScroll = () => {
      if (scrollEl) {
        scrollEl.removeEventListener('scroll', requestViewportUpdate)
        scrollEl = null
      }
    }

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
      scrollEl.addEventListener('scroll', requestViewportUpdate, { passive: true })
      requestRepaint(true)
    }

    setMinimapUpdateHandler(update => {
      if (update.docChanged) requestRepaint(false)
      if (update.geometryChanged) {
        requestViewportUpdate()
      }
    })

    attach()

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
      setMinimapUpdateHandler(null)
      detachScroll()
      ro?.disconnect()
      window.removeEventListener('qingcode:theme-changed', onTheme)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, fileSize, viewRef])

  const jumpToClientY = (clientY: number) => {
    const view = viewRef.current
    const root = rootRef.current
    if (!view || !root) return
    const rect = root.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)))
    const scrollDOM = view.scrollDOM
    const maxScroll = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight)
    scrollDOM.scrollTop = ratio * maxScroll
    requestViewportUpdate()
  }

  const onCanvasPointerDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    jumpToClientY(event.clientY)

    const onMove = (e: MouseEvent) => jumpToClientY(e.clientY)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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

  if (mode === 'hidden') return null

  const resizeHint = t('左右拖曳调整小地图宽度')

  return (
    <div
      ref={rootRef}
      className={`editor-minimap${resizing ? ' editor-minimap--resizing' : ''}`}
      style={{ width }}
      aria-hidden
    >
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
        onMouseDown={onCanvasPointerDown}
      />
      <div ref={viewportRef} className="editor-minimap__viewport" />
    </div>
  )
}
