import {
  useEffect,
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
  type SelectionSnapshot,
} from '../lib/selection'
import { IconButton } from './ui'

const emptyHighlights: readonly Range[] = []
const annotationHighlightName = 'qn-chat-annotation'

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
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null)
  const [commenting, setCommenting] = useState(false)
  const [comment, setComment] = useState('')
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

  // 消息重新换行后，浮层不能继续使用原来的选区坐标。
  useLayoutEffect(() => {
    setSnapshot(null)
  }, [layoutKey])

  const dismiss = (clearBrowserSelection = true): void => {
    setSnapshot(null)
    setCommenting(false)
    setComment('')
    if (clearBrowserSelection) clearDomSelection()
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const inToolbar = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('[data-qn-selection]') !== null

  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (inToolbar(event.target)) return
    // 重新拖选时先撤掉旧浮层，DOM 选区交给浏览器自然处理。
    if (snapshot) dismiss(false)
  }

  const onMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (inToolbar(event.target)) return
    const root = rootRef.current
    const next = root ? captureSelection(root) : null
    if (!next) {
      dismiss()
      return
    }
    setSnapshot(next)
    setCommenting(false)
    setComment('')
  }

  const confirm = () => {
    if (!snapshot) return
    onAdd(snapshot.text, comment.trim(), snapshot.range)
    dismiss()
  }

  const openSide = () => {
    if (!snapshot) return
    onSide?.(snapshot.text, snapshot.itemId)
    dismiss()
  }

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
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onScroll={onScroll}
    >
      {snapshot && (
        <div
          data-qn-selection
          className="absolute z-30 select-none"
          style={{
            top: snapshot.position.top,
            left: snapshot.position.left,
            transform: snapshot.position.above ? 'translateY(-100%)' : undefined,
          }}
        >
        <div className="qn-pop qn-surface-float flex items-center gap-1 p-1 text-ui-sm">
          {!commenting ? (
            <>
              <button
                type="button"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 hover:bg-qn-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setCommenting(true)
                  clearDomSelection()
                }}
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
