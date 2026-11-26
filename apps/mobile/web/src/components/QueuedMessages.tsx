import { ListOrdered, X } from 'lucide-react'
import { selectedQueuedSends, useApp } from '../store'
import { Badge, Button } from './ui'

export function QueuedMessages() {
  const queue = useApp(selectedQueuedSends)
  const connected = useApp((state) => state.eventsConnected)
  const remove = useApp((state) => state.removeQueuedSend)
  const retry = useApp((state) => state.retryQueuedSend)
  if (!queue?.length) return null

  const first = queue[0]
  return (
    <section className="shrink-0 border-t border-qn-border bg-qn-panel px-3" aria-label="发送队列">
      <details className="qn-details" open>
        <summary>
          <ListOrdered size={16} className="mr-1.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{queue.length} 条消息排队</span>
          {first?.error && <Badge tone="warn">已暂停</Badge>}
        </summary>
        {first?.error && (
          <div className="mb-1 flex items-center gap-2 text-xs text-qn-warn">
            <span className="min-w-0 flex-1 wrap-anywhere">{first.error}</span>
            <Button variant="ghost" className="shrink-0 px-2 text-xs" disabled={!connected} onClick={() => void retry()}>继续发送</Button>
          </div>
        )}
        <ul className="qn-scroll mb-2 max-h-[min(26dvh,9rem)] overflow-y-auto" aria-label="待发送的消息">
          {queue.map((message, index) => (
            <li key={message.id} className="flex items-center gap-2 border-t border-qn-border text-sm">
              <span className="min-w-0 flex-1 truncate">{message.text || `${message.imageCount} 张图片`}</span>
              {message.sending ? <Badge>发送中</Badge> : (
                <Button variant="ghost" className="qn-icon-button" aria-label={`移除排队消息 ${index + 1}`} onClick={() => remove(message.id)}>
                  <X size={16} aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
