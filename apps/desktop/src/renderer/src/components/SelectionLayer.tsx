import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from 'react'
import { Check, MessageSquarePlus, PanelRightOpen, X } from 'lucide-react'
import {
  captureSelection,
  clearDomSelection,
  selectionPosition,
  type SelectionSnapshot,
  type ToolbarPosition,
} from '../lib/selection'
import { IconButton } from './ui'

const emptyHighlights: readonly Range[] = []
const annotationHighlightName = 'qn-chat-annotation'
type ActiveSelection = { snapshot: SelectionSnapshot; position: ToolbarPosition }

const inToolbar = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-qn-selection]') !== null

export function SelectionLayer({
  children,
  onAdd,
  onSide,
  highlights = emptyHighlights,
  onScroll,
  className = '',
  showSideAction = true,
  containerRef,
  layoutKey,
}: {
  children: ReactNode
  onAdd: (quote: string, comment: string, range: Range) => void
  onSide?: (quote: string, itemId?: string) => void
  highlights?: readonly Range[]
  onScroll?: (event: UIEvent<HTMLDivElement>) => void
  className?: string
  showSideAction?: boolean
  containerRef?: RefObject<HTMLDivElement | null>
  layoutKey?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<ActiveSelection | null>(null)
  const [commenting, setCommenting] = useState(false)
  const [comment, setComment] = useState('')
  const snapshot = active?.snapshot
  const commentRange = commenting ? snapshot?.range : undefined

  useLayoutEffect(() => {
    const ranges = commentRange ? [...highlights, commentRange] : highlights
    const registry = globalThis.CSS?.highlights
    if (!registry || ranges.length === 0) return

    // 主对话和侧聊共用样式，关闭其中一处时只移除它自己的选区。
    const highlight = registry.get(annotationHighlightName) ?? new Highlight()
    for (const range of ranges) highlight.add(range)
    registry.set(annotationHighlightName, highlight)
    return () => {
      for (const range of ranges) highlight.delete(range)
      if (highlight.size === 0) registry.delete(annotationHighlightName)
    }
  }, [highlights, commentRange])

  const dismiss = useCallback((clearBrowserSelection = true) => {
    setActive(null)
    setCommenting(false)
    setComment('')
    if (clearBrowserSelection && rootRef.current) clearDomSelection(rootRef.current)
  }, [])

  useLayoutEffect(() => {
    dismiss()
  }, [layoutKey, dismiss])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !snapshot) return
    const document = root.ownerDocument
    let frame = 0
    const refresh = () => {
      frame = 0
      const position = selectionPosition(root, snapshot, commenting)
      if (!position) {
        dismiss(false)
        return
      }
      setActive((current) => {
        if (!current || current.snapshot !== snapshot) return current
        const previous = current.position
        return previous.top === position.top && previous.left === position.left && previous.above === position.above
          ? current : { snapshot, position }
      })
    }
    const scheduleRefresh = () => {
      if (frame === 0) frame = requestAnimationFrame(refresh)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0 && !inToolbar(event.target)) dismiss(!event.shiftKey)
    }
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) dismiss()
    }

    // 流式正文、折叠详情和滚动都可能在工具条打开时改变选区的位置。
    const mutations = new MutationObserver((records) => {
      if (records.some(({ target }) => !inToolbar(target instanceof Element ? target : target.parentElement))) {
        scheduleRefresh()
      }
    })
    mutations.observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden', 'class', 'style'],
    })
    const resize = new ResizeObserver(scheduleRefresh)
    resize.observe(root)
    root.addEventListener('scroll', scheduleRefresh, true)
    document.addEventListener('selectionchange', scheduleRefresh)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onEscape)
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resize.disconnect()
      root.removeEventListener('scroll', scheduleRefresh, true)
      document.removeEventListener('selectionchange', scheduleRefresh)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onEscape)
    }
  }, [snapshot, commenting, dismiss])

  const onMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || inToolbar(event.target)) return
    const root = rootRef.current
    const snapshot = root && captureSelection(root)
    const position = root && snapshot && selectionPosition(root, snapshot, false)
    if (!snapshot || !position) return
    setActive({ snapshot, position })
    setCommenting(false)
    setComment('')
  }

  const withSelection = (action: (snapshot: SelectionSnapshot, root: HTMLDivElement) => void) => {
    const root = rootRef.current
    if (root && snapshot && selectionPosition(root, snapshot, commenting)) action(snapshot, root)
    else dismiss(false)
  }

  const confirm = () => withSelection((snapshot) => {
    onAdd(snapshot.text, comment.trim(), snapshot.range)
    dismiss()
  })

  const openSide = () => withSelection((snapshot) => {
    onSide?.(snapshot.text, snapshot.itemId)
    dismiss()
  })

  const commentKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      confirm()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    }
  }

  return (
    <div
      ref={(node) => {
        rootRef.current = node
        if (containerRef) containerRef.current = node
      }}
      className={`qn-chat-selection relative ${className}`}
      onMouseUp={onMouseUp}
      onScroll={onScroll}
    >
      {active && (
        <div
          data-qn-selection
          className="absolute z-30 select-none"
          style={{
            top: active.position.top,
            left: active.position.left,
            transform: active.position.above ? 'translateY(-100%)' : undefined,
          }}
        >
        <div className="qn-pop qn-surface-float flex items-center gap-1 p-1 text-ui-sm">
          {!commenting ? (
            <>
              <button
                type="button"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 hover:bg-qn-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => withSelection((_, root) => {
                  setCommenting(true)
                  clearDomSelection(root)
                })}
              >
                <MessageSquarePlus size={13} /> 添加到对话
              </button>
              {showSideAction && (
                <button
                  type="button"
                  className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 hover:bg-qn-hover"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openSide}
                >
                  <PanelRightOpen size={13} /> 在侧边聊天中提问
                </button>
              )}
            </>
          ) : (
            <>
              <input
                autoFocus
                className="qn-input h-7 w-52 select-text px-2.5 py-0 text-ui-sm"
                placeholder="添加可选评论…"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={commentKeyDown}
              />
              <IconButton
                label="确认注释（Enter）"
                className="h-7 w-7 text-qn-ok"
                onMouseDown={(event) => event.preventDefault()}
                onClick={confirm}
              >
                <Check size={14} />
              </IconButton>
              <IconButton
                label="取消（Esc）"
                className="h-7 w-7"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => dismiss()}
              >
                <X size={14} />
              </IconButton>
            </>
          )}
        </div>
        </div>
      )}
      {children}
    </div>
  )
}
