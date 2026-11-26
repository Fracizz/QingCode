import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Annotation } from '../state'
import { Button, Note } from './ui'

export type ComposerProps = {
  onSend: (text: string) => void
  onInterrupt: () => void
  running: boolean
  sending: boolean
  disabled?: boolean
  error: string | null
  onClearError: () => void
  annotations: Annotation[]
  onUpdateAnnotation: (id: string, comment: string) => void
  onRemoveAnnotation: (id: string) => void
  quoteDraft: string | null
  onConfirmQuote: (quote: string, comment: string) => void
  onCancelQuote: () => void
  /** 占位符随 Agent 变化（"和 Claude 一起工作"）。 */
  placeholder?: string
  /** 输入框上方的工具条（Agent 标识、模型选择）。 */
  toolbar?: ReactNode
}

export function Composer({
  onSend,
  onInterrupt,
  running,
  sending,
  disabled,
  error,
  onClearError,
  annotations,
  onUpdateAnnotation,
  onRemoveAnnotation,
  quoteDraft,
  onConfirmQuote,
  onCancelQuote,
  placeholder = '和 Codex 一起工作',
  toolbar,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [comment, setComment] = useState('')
  const [showAnnotations, setShowAnnotations] = useState(false)
  const composing = useRef(false)

  useEffect(() => {
    setComment('')
  }, [quoteDraft])

  const submit = () => {
    const value = text.trim()
    if ((!value && annotations.length === 0) || disabled || sending) return
    onSend(value)
    setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) {
      event.preventDefault()
      submit()
    }
  }

  const confirmQuote = () => {
    if (!quoteDraft) return
    onConfirmQuote(quoteDraft, comment)
    setComment('')
  }

  return (
    <div className="qn-footer">
      {error && <Note message={error} tone="error" onClose={onClearError} />}

      {quoteDraft && (
        <div className="mb-2 rounded-xl border border-qn-accent/50 bg-qn-card p-2">
          <div className="mb-1 text-[11px] text-qn-muted">添加到对话（可选评论）</div>
          <div className="qn-mono mb-2 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-qn-text/80">
            {quoteDraft}
          </div>
          <div className="flex gap-2">
            <input
              className="qn-input flex-1"
              value={comment}
              placeholder="添加可选评论…"
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  confirmQuote()
                } else if (event.key === 'Escape') {
                  onCancelQuote()
                }
              }}
            />
            <Button variant="primary" className="px-3" onClick={confirmQuote} aria-label="确认引用">
              ✓
            </Button>
            <Button className="px-3" onClick={onCancelQuote} aria-label="取消引用">
              ✕
            </Button>
          </div>
        </div>
      )}

      {annotations.length > 0 && (
        <div className="mb-2">
          <button
            type="button"
            className="qn-button qn-button-ghost w-full justify-start px-3 py-1 text-xs"
            onClick={() => setShowAnnotations((value) => !value)}
          >
            💬 {annotations.length} 条注释 {showAnnotations ? '▴' : '▾'}
          </button>
          {showAnnotations && (
            <div className="mt-1 space-y-2">
              {annotations.map((annotation) => (
                <div key={annotation.id} className="rounded-lg border border-qn-border bg-black/20 p-2">
                  <div className="mb-1 flex items-start gap-2">
                    <div className="qn-mono min-w-0 flex-1 whitespace-pre-wrap break-words text-[11px] text-qn-muted">
                      {annotation.quote}
                    </div>
                    <Button
                      variant="ghost"
                      className="px-3 py-1 text-xs"
                      onClick={() => onRemoveAnnotation(annotation.id)}
                      aria-label="删除注释"
                    >
                      ✕
                    </Button>
                  </div>
                  <input
                    className="qn-input"
                    value={annotation.comment}
                    placeholder="评论（可空）"
                    onChange={(event) => onUpdateAnnotation(annotation.id, event.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toolbar && <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">{toolbar}</div>}

      <textarea
        className="qn-textarea"
        rows={3}
        value={text}
        disabled={disabled}
        placeholder={disabled ? '请先连接目标' : placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-qn-muted">
          {running ? 'Agent 正在运行…' : sending ? '正在发送…' : 'Enter 发送 · Shift+Enter 换行'}
        </span>
        {running && (
          <Button variant="danger" className="px-3" onClick={onInterrupt}>
            ■ 中断
          </Button>
        )}
        <Button variant="primary" className="px-4" onClick={submit} disabled={disabled || sending}>
          发送 ↑
        </Button>
      </div>
    </div>
  )
}
