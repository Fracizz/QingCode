import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Frame,
  Image as ImageIcon,
  ImageOff,
  LoaderCircle,
  Maximize,
  RotateCw,
} from 'lucide-react'
import { safeInvoke } from '../lib/tauri'
import { formatFileSize } from '../lib/fileSizePolicy'
import { IMAGE_MAX_BYTES, mimeForImage } from '../lib/imageFiles'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'
import type { EditorTab } from '../types'

interface Props {
  tab: EditorTab
}

type NaturalSize = { width: number; height: number }

type ViewportSize = { width: number; height: number }

type ImageView = {
  /** `true` = contain-fit inside the viewport (default). */
  fit: boolean
  /** Explicit scale (1 = 100%); ignored while `fit`. */
  scale: number
  /** Top-left translation in viewport px; ignored while `fit` (auto-centered). */
  offset: { x: number; y: number }
}

const DEFAULT_VIEW: ImageView = { fit: true, scale: 1, offset: { x: 0, y: 0 } }

const ZOOM_STEP = 1.1
const MIN_SCALE = 0.05
const MAX_SCALE = 32
/** Breathing room around a contained image. */
const FIT_PADDING = 24

/** Transparent-image checkerboard (two offset 45° gradients). */
function checkerboardStyle(): CSSProperties {
  const square = 'rgba(128, 128, 128, 0.18)'
  return {
    backgroundColor: 'var(--color-bg-elevated)',
    backgroundImage: [
      `linear-gradient(45deg, ${square} 25%, transparent 25% 75%, ${square} 75%)`,
      `linear-gradient(45deg, ${square} 25%, transparent 25% 75%, ${square} 75%)`,
    ].join(', '),
    backgroundPosition: '0 0, 8px 8px',
    backgroundSize: '16px 16px',
  }
}

export default function ImageViewer({ tab }: Props) {
  const { t } = useI18n()
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [byteLength, setByteLength] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [natural, setNatural] = useState<NaturalSize | null>(null)
  const [view, setView] = useState<ImageView>(DEFAULT_VIEW)
  const [viewport, setViewport] = useState<ViewportSize | null>(null)
  const requestId = useRef(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  // Load image bytes as a Blob object URL; revoke on change/unmount.
  useEffect(() => {
    if (tab.fileSize != null && tab.fileSize > IMAGE_MAX_BYTES) {
      setError(
        t('图片过大（{size}），超过 64MB 上限', { size: formatFileSize(tab.fileSize) })
      )
      setLoading(false)
      return
    }
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    setNatural(null)
    setView(DEFAULT_VIEW)
    let createdUrl: string | null = null
    safeInvoke<ArrayBuffer | Uint8Array>('读取图片', 'read_image_file', { path: tab.path })
      .then(bytes => {
        if (id !== requestId.current) return
        createdUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeForImage(tab.path) }))
        setObjectUrl(createdUrl)
        setByteLength(bytes.byteLength)
        setLoading(false)
      })
      .catch(e => {
        if (id !== requestId.current) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path, tab.diskMtime, attempt])

  // Track the viewport size so fit-scale / centering stay correct on resize.
  useEffect(() => {
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setViewport({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitScale =
    natural && viewport && natural.width > 0 && natural.height > 0
      ? Math.min(
          Math.max(0.01, (viewport.width - FIT_PADDING) / natural.width),
          Math.max(0.01, (viewport.height - FIT_PADDING) / natural.height),
        )
      : null

  const renderScale = view.fit ? (fitScale ?? 1) : view.scale
  const renderOffset = view.fit
    ? viewport && natural
      ? {
          x: (viewport.width - natural.width * renderScale) / 2,
          y: (viewport.height - natural.height * renderScale) / 2,
        }
      : { x: 0, y: 0 }
    : view.offset

  // Latest computed transform for the non-passive wheel handler below.
  const transformRef = useRef({ scale: renderScale, x: renderOffset.x, y: renderOffset.y })
  useEffect(() => {
    transformRef.current = { scale: renderScale, x: renderOffset.x, y: renderOffset.y }
  }, [renderScale, renderOffset.x, renderOffset.y])

  const applyZoom = useCallback((nextScale: number, anchor: { x: number; y: number }) => {
    setView(current => {
      const scale = current.fit ? (fitScale ?? 1) : current.scale
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
      if (next === scale) return current
      // Keep the content point under the anchor fixed: c = (anchor - offset)/scale.
      const cx = (anchor.x - transformRef.current.x) / scale
      const cy = (anchor.y - transformRef.current.y) / scale
      return {
        fit: false,
        scale: next,
        offset: { x: anchor.x - cx * next, y: anchor.y - cy * next },
      }
    })
  }, [fitScale])

  // Ctrl+wheel zoom must preventDefault, which React's passive onWheel cannot.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      applyZoom(transformRef.current.scale * factor, anchor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  const zoomToActual = () => {
    const el = viewportRef.current
    const width = el?.clientWidth ?? 0
    const height = el?.clientHeight ?? 0
    setView({
      fit: false,
      scale: 1,
      offset: natural
        ? { x: (width - natural.width) / 2, y: (height - natural.height) / 2 }
        : { x: 0, y: 0 },
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (view.fit || !natural) return
    dragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.lastX
    const dy = event.clientY - drag.lastY
    dragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY }
    setView(current => ({
      ...current,
      fit: false,
      offset: { x: current.offset.x + dx, y: current.offset.y + dy },
    }))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  const pannable = !view.fit && !!natural
  const displaySize = byteLength ?? tab.fileSize
  const formatShort = mimeForImage(tab.path).split('/').pop() ?? ''
  const zoomPercent = `${Math.round(renderScale * 100)}%`

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-bg text-fg-muted">
        <LoaderCircle size={28} className="animate-spin text-accent" aria-hidden />
        <p className="text-ui-lg">{t('读取图片中…')}</p>
        <Tooltip
          label={tab.path}
          side="bottom"
          onlyWhenOverflow
          wrapperClassName="max-w-md block px-6"
        >
          <p className="text-ui-sm truncate font-mono text-fg-dim">{tab.path}</p>
        </Tooltip>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-bg text-fg-muted px-6 text-center">
        <ImageOff size={32} className="text-warn" aria-hidden />
        <p className="text-ui-lg">{t('加载图片失败')}</p>
        <p className="max-w-xl break-all font-mono text-ui-sm text-fg-dim">{error}</p>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-ui-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
          onClick={() => setAttempt(count => count + 1)}
        >
          <RotateCw size={14} />
          {t('重试')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-ui-xs text-fg-muted">
        <ImageIcon size={12} className="flex-shrink-0 text-accent" aria-hidden />
        <span className="truncate">{tab.name}</span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1">
          <Tooltip label={t('适应窗口')} side="bottom">
            <button
              type="button"
              aria-label={t('适应窗口')}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                view.fit
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
              onClick={() => setView(DEFAULT_VIEW)}
            >
              <Maximize size={12} />
              {t('适应窗口')}
            </button>
          </Tooltip>
          <Tooltip label={t('原始大小')} side="bottom">
            <button
              type="button"
              aria-label={t('原始大小')}
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors ${
                !view.fit && view.scale === 1
                  ? 'bg-bg-active text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
              onClick={zoomToActual}
            >
              <Frame size={12} />
              {t('原始大小')}
            </button>
          </Tooltip>
        </span>
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-hidden select-none"
        style={checkerboardStyle()}
        role="img"
        aria-label={tab.name}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          if (view.fit) {
            zoomToActual()
          } else {
            setView(DEFAULT_VIEW)
          }
        }}
      >
        {objectUrl && (
          <img
            src={objectUrl}
            decoding="async"
            draggable={false}
            alt=""
            className="absolute left-0 top-0 max-w-none origin-top-left"
            style={{
              width: natural ? natural.width : undefined,
              height: natural ? natural.height : undefined,
              transform: `translate(${renderOffset.x}px, ${renderOffset.y}px) scale(${renderScale})`,
              cursor: pannable ? (dragging ? 'grabbing' : 'grab') : 'default',
            }}
            onLoad={event => {
              const el = event.currentTarget
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setNatural({ width: el.naturalWidth, height: el.naturalHeight })
              }
            }}
          />
        )}
      </div>

      <div className="flex h-6 flex-shrink-0 items-center gap-3 border-t border-border px-3 text-ui-xs text-fg-dim">
        <span className="font-mono">{natural ? `${natural.width}×${natural.height}` : '…'}</span>
        <span className="font-mono">
          {displaySize != null ? formatFileSize(displaySize) : '…'}
        </span>
        <span className="font-mono">{zoomPercent}</span>
        <span className="uppercase">{formatShort}</span>
        <span className="ml-auto truncate font-mono text-fg-dim">{tab.path}</span>
      </div>
    </div>
  )
}
