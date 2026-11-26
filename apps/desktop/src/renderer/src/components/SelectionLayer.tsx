import {
  useEffect,
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
  type Box,
  type SelectionSnapshot,
} from '../lib/selection'

export function SelectionLayer({
  children,
  onAdd,
  onSide,
  highlights = [],
  onScroll,
  className = '',
  showSideAction = true,
  containerRef,
}: {
  children: ReactNode
  onAdd: (quote: string, comment: string, boxes: Box[]) => void
  onSide?: (quote: string) => void
  highlights?: Box[]
  onScroll?: (event: UIEvent<HTMLDivElement>) => void
  className?: string
  showSideAction?: boolean
  containerRef?: RefObject<HTMLDivElement | null>
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null)
  const [commenting, setCommenting] = useState(false)
  const [comment, setComment] = useState('')

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
    onAdd(snapshot.text, comment.trim(), snapshot.boxes)
    dismiss()
  }

  const openSide = () => {
    if (!snapshot) return
    onSide?.(snapshot.text)
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

  const boxes = [...highlights, ...(snapshot?.boxes ?? [])]

  return (
    <div
      ref={(node) => {
        rootRef.current = node
        if (containerRef) containerRef.current = node
      }}
      className={`relative ${className}`}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onScroll={onScroll}
    >
      <div className="pointer-events-none absolute inset-0 z-10">
        {boxes.map((box, index) => (
          <div
            key={index}
            className="absolute rounded-sm bg-qn-accent/25 ring-1 ring-qn-accent/40"
            style={{
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height,
            }}
          />
        ))}
      </div>
      {snapshot && (
        <div
          data-qn-selection
          className="absolute z-30 flex items-center gap-1 rounded-md border border-qn-border bg-[#282828] p-1 text-[11px] shadow-xl"
          style={{ top: snapshot.position.top, left: snapshot.position.left }}
        >
          {!commenting ? (
            <>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setCommenting(true)}
              >
                <MessageSquarePlus size={13} /> 添加到对话
              </button>
              {showSideAction && (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-2 py-1 hover:bg-white/10"
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
                className="qn-input w-44 px-2 py-1 text-[11px]"
                placeholder="添加可选评论…"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={commentKeyDown}
              />
              <button
                type="button"
                className="rounded p-1 text-emerald-300 hover:bg-white/10"
                title="确认注释（Enter）"
                aria-label="确认注释"
                onMouseDown={(event) => event.preventDefault()}
                onClick={confirm}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                className="rounded p-1 text-qn-muted hover:bg-white/10 hover:text-white"
                title="取消（Esc）"
                aria-label="取消注释"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => dismiss()}
              >
                <X size={13} />
              </button>
            </>
          )}
        </div>
      )}
      {children}
    </div>
  )
}
