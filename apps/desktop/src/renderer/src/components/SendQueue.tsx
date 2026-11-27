import type { UserInput } from '@qn/codex-client'
import { FileText, Image as ImageIcon, ListEnd, Wand2, X } from 'lucide-react'
import type { AgentKind } from '../../../shared/backendApi'
import { isAbsolutePath, joinPath } from '../features/files/fileLinks'
import { openFile } from '../features/workspace/openers'
import { basename } from '../lib/attachments'
import { pendingSendKey, useCodex } from '../store/codex'
import { MessageImage } from './MessageImage'
import { IconButton } from './ui'

function attachmentPreviews(input: readonly UserInput[], targetId: string, cwd: string | null) {
  let imageCount = 0
  return input.flatMap((entry, index) => {
    if (entry.type === 'image' && 'url' in entry && entry.url.startsWith('data:image/')) {
      return <MessageImage key={index} src={entry.url} label={`附件图片 ${++imageCount}`} compact />
    }
    if (entry.type !== 'mention' && entry.type !== 'skill' && entry.type !== 'localImage' && entry.type !== 'localAudio') return []

    const Icon = entry.type === 'skill' ? Wand2 : entry.type === 'localImage' ? ImageIcon : FileText
    const name = 'name' in entry ? entry.name : basename(entry.path)
    const label = `${entry.type === 'skill' ? '查看技能' : '打开附件'} ${name}`
    const path = isAbsolutePath(entry.path) ? entry.path : cwd && entry.path.trim() ? joinPath(cwd, entry.path) : null
    return (
      <IconButton key={index} label={label} size="sm" disabled={!path}
        className="border border-qn-border-strong bg-qn-panel"
        onClick={() => { if (path) openFile({ targetId, path }) }}>
        <Icon size={13} aria-hidden />
      </IconButton>
    )
  })
}

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
  const cwd = useCodex((state) => state.currentTargetId === targetId ? state.currentCwd : null)
  const remove = useCodex((state) => state.removePendingSend)
  const retry = useCodex((state) => state.retryPendingSend)
  if (!chat || !pending?.length) return null

  return (
    <div className={`shrink-0 ${compact ? 'px-3' : 'px-6'}`}>
      <section
        aria-label="发送队列"
        className={`mx-auto rounded-xl border border-qn-border bg-qn-panel px-3 py-2 text-[12px] ${contentWidthClassName}`}
      >
        <div className="flex items-center gap-1.5 text-qn-muted"><ListEnd size={14} /> 排队消息（{pending.length}）</div>
        <ul className="qn-scroll mt-1 max-h-32 space-y-0.5 overflow-auto">
          {pending.map((item) => {
            const text = item.text.trim()
            const attachments = attachmentPreviews(item.input, chat.targetId, cwd)
            return (
              <li key={item.id} className="rounded-md bg-qn-elevated px-2">
                <div className="flex min-h-7 items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {(text || !attachments.length) && <span className="min-w-0 truncate">{text || '附件或技能'}</span>}
                    {attachments.length > 0 && (
                      <div className={`flex shrink-0 flex-wrap gap-1 py-0.5 ${text ? 'max-w-1/2' : 'max-w-full'}`}>
                        {attachments}
                      </div>
                    )}
                  </div>
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
            )
          })}
        </ul>
      </section>
    </div>
  )
}
