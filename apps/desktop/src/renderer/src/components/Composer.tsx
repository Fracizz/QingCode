import { useRef, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { agentPlaceholder } from '../lib/agents'
import { AgentIcon } from './AgentIcon'
import { ErrorNote } from './ui'

export function Composer({
  onSend,
  onInterrupt,
  running,
  sending,
  disabled,
  error,
  onClearError,
  value,
  onChange,
  agent,
  annotationCount = 0,
  compact = false,
}: {
  onSend: (text: string) => void
  onInterrupt: () => void
  running: boolean
  sending: boolean
  disabled?: boolean
  error: string | null
  onClearError: () => void
  value: string
  onChange: (value: string) => void
  agent: AgentKind
  annotationCount?: number
  compact?: boolean
}) {
  const composing = useRef(false)

  const submit = () => {
    const trimmed = value.trim()
    if ((!trimmed && annotationCount === 0) || disabled || sending) return
    onSend(value)
    onChange('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composing.current
    ) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className={`shrink-0 border-t border-qn-border bg-qn-panel ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
      {error && <div className="mb-2"><ErrorNote message={error} onClose={onClearError} /></div>}
      <textarea
        className="qn-input resize-none rounded-xl px-3 py-2 font-sans text-sm leading-5"
        rows={compact ? 2 : 3}
        value={value}
        disabled={disabled}
        placeholder={disabled ? '请先连接目标' : agentPlaceholder(agent)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-qn-muted">
          <AgentIcon agent={agent} label />
          {annotationCount > 0 && <span>· {annotationCount} 条注释待发送</span>}
          {!annotationCount && !running && !sending && <span>· Enter 发送 / Shift+Enter 换行</span>}
          {(running || sending) && <span>· {running ? '正在运行…' : '正在发送…'}</span>}
        </span>
        <div className="flex shrink-0 gap-2">
          {running && (
            <button
              type="button"
              className="qn-button-subtle flex items-center gap-1 border-qn-danger/50 text-qn-danger"
              onClick={onInterrupt}
            >
              <Square size={12} /> 中断
            </button>
          )}
          <button
            type="button"
            className="qn-button flex h-8 w-8 items-center justify-center rounded-full p-0"
            disabled={disabled || sending || (!value.trim() && annotationCount === 0)}
            title="发送（Enter）"
            aria-label="发送"
            onClick={submit}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
