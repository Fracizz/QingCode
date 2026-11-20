import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  Frame,
  Image as ImageIcon,
  ImageOff,
  LoaderCircle,
  Maximize,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { safeInvoke } from '../lib/tauri'
import { formatFileSize } from '../lib/fileSizePolicy'
import { IMAGE_MAX_BYTES, mimeForImage } from '../lib/imageFiles'
import { useI18n } from '../lib/i18n'
import {
  MAX_SCALE,
  MIN_SCALE,
  PIXELATED_SCALE,
  centeredOffset,
  clampOffset,
  clampScale,
  fitScaleFor,
  imageTransform,
  nextZoomLevel,
  prevZoomLevel,
  rotatedSize,
  wheelZoomFactor,
  zoomOffsetAt,
  type Point,
  type Size,
} from '../utils/imageViewTransform'
import Tooltip from './Tooltip'
import type { EditorTab } from '../types'

interface Props {
  tab: EditorTab
}

type ImageView = {
  /** `true` = contain-fit inside the viewport (default). */
  fit: boolean
  /** Explicit scale (1 = 100%); ignored while `fit`. */
  scale: number
  /** Top-left of the rotated bounding box in viewport px; ignored while `fit` (auto-centered). */
  offset: Point
  /** 按钮 / 键盘 / 双击触发的变化走过渡动画；滚轮与拖拽需即时跟手。 */
  animate: boolean
}

const DEFAULT_VIEW: ImageView = { fit: true, scale: 1, offset: { x: 0, y: 0 }, animate: false }

/** Breathing room around a contained image. */
const FIT_PADDING = 24
/** 方向键平移步长（Shift 加速）。 */
const PAN_STEP = 48
const PAN_STEP_FAST = 240

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

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        className={`inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded px-1.5 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
          active ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
        }`}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export default function ImageViewer({ tab }: Props) {
  const { t } = useI18n()
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [byteLength, setByteLength] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [natural, setNatural] = useState<Size | null>(null)
  const [view, setView] = useState<ImageView>(DEFAULT_VIEW)
  /** 顺时针 90° 的累计次数（不取模，避免 270°→0° 时动画反向转一圈）。 */
  const [turns, setTurns] = useState(0)
  const [viewport, setViewport] = useState<Size | null>(null)
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
    setTurns(0)
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
  // 加载态与错误态不渲染视口，loading / error 变化后要重新挂观察者。
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading, error])

  const box = natural ? rotatedSize(natural, turns) : null
  const fitScale = box && viewport ? fitScaleFor(box, viewport, FIT_PADDING) : null

  const renderScale = view.fit ? (fitScale ?? 1) : view.scale
  const renderOffset = view.fit
    ? box && viewport
      ? centeredOffset(box, renderScale, viewport)
      : { x: 0, y: 0 }
    : view.offset

  // 事件处理器读取的最新几何信息；交互中会同步写回，保证同一帧内连续的滚轮 / 拖拽不丢步。
  const geometryRef = useRef({ scale: renderScale, offset: renderOffset, box, viewport })
  useEffect(() => {
    geometryRef.current = { scale: renderScale, offset: renderOffset, box, viewport }
  })

  /** 以 anchor（视口坐标，缺省为视口中心）为不动点缩放到 target。 */
  const zoomTo = useCallback((target: number, anchor: Point | null, animate: boolean) => {
    const geo = geometryRef.current
    if (!geo.box || !geo.viewport) return
    const next = clampScale(target)
    if (next === geo.scale) return
    const point = anchor ?? { x: geo.viewport.width / 2, y: geo.viewport.height / 2 }
    const offset = clampOffset(
      zoomOffsetAt(geo.offset, geo.scale, next, point),
      geo.box,
      next,
      geo.viewport,
    )
    geometryRef.current = { ...geo, scale: next, offset }
    setView({ fit: false, scale: next, offset, animate })
  }, [])

  const panBy = useCallback((dx: number, dy: number) => {
    const geo = geometryRef.current
    if (!geo.box || !geo.viewport) return
    const offset = clampOffset(
      { x: geo.offset.x + dx, y: geo.offset.y + dy },
      geo.box,
      geo.scale,
      geo.viewport,
    )
    geometryRef.current = { ...geo, offset }
    setView({ fit: false, scale: geo.scale, offset, animate: false })
  }, [])

  const fitToWindow = useCallback(() => setView({ ...DEFAULT_VIEW, animate: true }), [])

  const zoomIn = useCallback(
    () => zoomTo(nextZoomLevel(geometryRef.current.scale), null, true),
    [zoomTo],
  )
  const zoomOut = useCallback(
    () => zoomTo(prevZoomLevel(geometryRef.current.scale), null, true),
    [zoomTo],
  )

  /** 原始大小：从适应窗口切换时居中显示，否则以视口中心为锚点。 */
  const zoomToActual = useCallback(() => {
    const geo = geometryRef.current
    if (!geo.box || !geo.viewport) return
    if (view.fit) {
      setView({ fit: false, scale: 1, offset: centeredOffset(geo.box, 1, geo.viewport), animate: true })
    } else {
      zoomTo(1, null, true)
    }
  }, [view.fit, zoomTo])

  /** 旋转时保持包围盒中心不动；适应窗口模式下自动按新方向重新适配。 */
  const rotate = useCallback((direction: 1 | -1) => {
    const { box: currentBox, viewport: currentViewport } = geometryRef.current
    setTurns(count => count + direction)
    if (!currentBox || !currentViewport) return
    setView(current => {
      if (current.fit) return { ...current, animate: true }
      const nextBox = { width: currentBox.height, height: currentBox.width }
      const center = {
        x: current.offset.x + (currentBox.width * current.scale) / 2,
        y: current.offset.y + (currentBox.height * current.scale) / 2,
      }
      const offset = clampOffset(
        {
          x: center.x - (nextBox.width * current.scale) / 2,
          y: center.y - (nextBox.height * current.scale) / 2,
        },
        nextBox,
        current.scale,
        currentViewport,
      )
      return { ...current, offset, animate: true }
    })
  }, [])

  // 滚轮（含触控板捏合 = ctrl+wheel）以光标为锚点缩放；需要 preventDefault，而 React 的 onWheel 是 passive。
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, rect.height)
      zoomTo(geometryRef.current.scale * factor, anchor, false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo, loading, error])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey) return
    let handled = true
    switch (event.key) {
      case '+':
      case '=':
        zoomIn()
        break
      case '-':
      case '_':
        zoomOut()
        break
      case '0':
        fitToWindow()
        break
      case '1':
        zoomToActual()
        break
      case 'r':
      case 'R':
        if (event.ctrlKey) handled = false
        else rotate(event.shiftKey ? -1 : 1)
        break
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (view.fit) {
          handled = false
          break
        }
        const step = event.shiftKey ? PAN_STEP_FAST : PAN_STEP
        // 方向键移动的是视野，图片朝相反方向移动。
        const dx = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
        const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
        panBy(dx, dy)
        break
      }
      default:
        handled = false
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 点击后视口获得焦点，键盘快捷键才生效。
    event.currentTarget.focus({ preventScroll: true })
    if (event.button !== 0 && event.button !== 1) return
    if (view.fit || !natural) return
    // 中键拖拽同样平移，阻止浏览器自动滚动。
    if (event.button === 1) event.preventDefault()
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
    panBy(dx, dy)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!view.fit) {
      fitToWindow()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    // 小图适应后已接近 100% 时，双击放大到 200% 才有可见变化。
    const target = fitScale != null && Math.abs(fitScale - 1) < 0.05 ? 2 : 1
    zoomTo(target, anchor, true)
  }

  const pannable = !view.fit && !!natural
  const isActualSize = !view.fit && Math.abs(view.scale - 1) < 1e-6
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
        <ImageOff size={28} strokeWidth={1.5} className="text-warn" aria-hidden />
        <p className="text-ui-lg">{t('加载图片失败')}</p>
        <p className="max-w-xl break-all font-mono text-ui-sm text-fg-dim">{error}</p>
        <button
          type="button"
          className="btn btn-secondary"
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
        <span className="min-w-0 truncate">{tab.name}</span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-0.5">
          <ToolbarButton
            label={`${t('缩小')} (-)`}
            disabled={!natural || renderScale <= MIN_SCALE}
            onClick={zoomOut}
          >
            <ZoomOut size={14} />
          </ToolbarButton>
          <Tooltip label={t('滚轮缩放，拖拽平移，双击切换适应窗口 / 原始大小')} side="bottom">
            <span
              className="inline-block w-11 text-center font-mono tabular-nums text-fg"
              data-testid="image-zoom-percent"
            >
              {zoomPercent}
            </span>
          </Tooltip>
          <ToolbarButton
            label={`${t('放大')} (+)`}
            disabled={!natural || renderScale >= MAX_SCALE}
            onClick={zoomIn}
          >
            <ZoomIn size={14} />
          </ToolbarButton>
          <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />
          <ToolbarButton label={`${t('适应窗口')} (0)`} active={view.fit} onClick={fitToWindow}>
            <Maximize size={12} />
            {t('适应窗口')}
          </ToolbarButton>
          <ToolbarButton label={`${t('原始大小')} (1)`} active={isActualSize} onClick={zoomToActual}>
            <Frame size={12} />
            {t('原始大小')}
          </ToolbarButton>
          <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />
          <ToolbarButton
            label={`${t('向左旋转')} (Shift+R)`}
            disabled={!natural}
            onClick={() => rotate(-1)}
          >
            <RotateCcw size={14} />
          </ToolbarButton>
          <ToolbarButton label={`${t('向右旋转')} (R)`} disabled={!natural} onClick={() => rotate(1)}>
            <RotateCw size={14} />
          </ToolbarButton>
        </span>
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-hidden select-none outline-none"
        style={{
          ...checkerboardStyle(),
          cursor: pannable ? (dragging ? 'grabbing' : 'grab') : natural ? 'zoom-in' : 'default',
        }}
        role="img"
        aria-label={tab.name}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
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
              // 尺寸未知前先隐藏，避免首帧以原始大小闪现。
              visibility: natural ? 'visible' : 'hidden',
              transform: natural
                ? imageTransform(renderOffset, renderScale, natural, turns)
                : undefined,
              transition:
                view.animate && !dragging ? 'transform var(--motion-enter) var(--ease-out)' : undefined,
              imageRendering: renderScale >= PIXELATED_SCALE ? 'pixelated' : undefined,
            }}
            onTransitionEnd={() =>
              setView(current => (current.animate ? { ...current, animate: false } : current))
            }
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
        <span className="uppercase">{formatShort}</span>
        <span className="ml-auto truncate font-mono text-fg-dim">{tab.path}</span>
      </div>
    </div>
  )
}
