import { ListEnd, X } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { pendingSendKey, useCodex } from '../store/codex'
import { IconButton } from './ui'

export function SendQueue({ targetId, agent, threadId, running, resumeDisabled, compact, contentWidthClassName = 'max-w-3xl' }: {
  targetId: string | null
  agent: AgentKind
  threadId: string | null
  running: boolean
  resumeDisabled?: boolean
  compact?: boolean
  contentWidthClassName?: string
}) {
  const chat = targetId && threadId ? { targetId, agent, threadId } : null
  const key = chat ? pendingSendKey(chat) : null
  const pending = useCodex((state) => key ? state.pendingSends[key] : undefined)
  const remove = useCodex((state) => state.removePendingSend)
  const retry = useCodex((state) => state.retryPendingSend)
  if (!chat || !pending?.length) return null

  return (
    <div className={`shrink-0 ${compact ? 'px-3' : 'px-6'}`}>
      <section
        aria-label="发送队列"
        className={`mx-auto rounded-xl border border-qn-border bg-qn-panel px-3 py-2 text-ui-sm ${contentWidthClassName}`}
      >
        <div className="flex items-center gap-1.5 text-qn-muted"><ListEnd size={14} /> 排队消息（{pending.length}）</div>
        <ul className="qn-scroll mt-1 max-h-32 space-y-0.5 overflow-auto">
          {pending.map((item) => (
            <li key={item.id} className="rounded-md bg-qn-elevated px-2">
              <div className="flex min-h-7 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate">{item.text.trim() || '附件或技能'}</span>
                {item.sending && <span role="status" className="shrink-0 text-qn-muted">发送中…</span>}
                {item.error && (
                  <button
                    type="button"
                    disabled={running || resumeDisabled || item.sending}
                    className="shrink-0 rounded px-1 text-qn-accent hover:underline disabled:opacity-40"
                    onClick={() => retry(chat)}
                  >
                    继续发送
                  </button>
                )}
                <IconButton label="移除排队消息" size="sm" disabled={item.sending} onClick={() => remove(chat, item.id)}>
                  <X size={13} />
                </IconButton>
              </div>
              {item.error && <div role="status" className="break-words pb-1 text-qn-warn">{item.error}</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
