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
  type Box,
  type SelectionSnapshot,
} from '../lib/selection'
import { IconButton } from './ui'

export function SelectionLayer({
  children,
  onAdd,
  onSide,
  highlights = [],
  onScroll,
  className = '',
  showSideAction = true,
  containerRef,
  layoutKey,
}: {
  children: ReactNode
  onAdd: (quote: string, comment: string, boxes: Box[]) => void
  onSide?: (quote: string) => void
  highlights?: Box[]
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
          className="absolute z-30"
          style={{
            top: snapshot.position.top,
            left: snapshot.position.left,
            transform: snapshot.position.above ? 'translateY(-100%)' : undefined,
          }}
        >
        <div className="qn-pop qn-surface-float flex items-center gap-1 p-1 text-[12px]">
          {!commenting ? (
            <>
              <button
                type="button"
                className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 hover:bg-qn-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setCommenting(true)}
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
                className="qn-input h-7 w-52 px-2.5 py-0 text-[12px]"
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
