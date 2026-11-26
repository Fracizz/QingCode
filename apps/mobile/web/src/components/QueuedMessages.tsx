import { ListOrdered, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { selectedQueuedSends, useApp } from '../store'
import { Badge, Button, Dialog, Note } from './ui'

export function QueuedMessages({ running, canSteer }: { running: boolean; canSteer: boolean }) {
  const queue = useApp(selectedQueuedSends)
  const connected = useApp((state) => state.eventsConnected)
  const remove = useApp((state) => state.removeQueuedSend)
  const retry = useApp((state) => state.retryQueuedSend)
  const beginEdit = useApp((state) => state.beginQueuedEdit)
  const saveEdit = useApp((state) => state.editQueuedSend)
  const steer = useApp((state) => state.steerQueuedSend)
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState(false)
  const unlock = useRef<(() => void) | null>(null)
  useEffect(() => () => unlock.current?.(), [])
  if (!queue?.length) return null

  function closeEditor() {
    unlock.current?.()
    unlock.current = null
    setEdit(null)
  }

  async function submitEdit() {
    if (!edit || saving) return
    setSaving(true)
    setEditError(false)
    try {
      if (await saveEdit(edit.id, edit.text)) closeEditor()
      else setEditError(true)
    } finally {
      setSaving(false)
    }
  }

  const first = queue[0]
  const edited = queue.find((item) => item.id === edit?.id)
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
            <Button variant="ghost" className="shrink-0 px-2 text-xs" disabled={!connected || running || first.sending || first.saving} onClick={() => void retry()}>继续发送</Button>
          </div>
        )}
        <ul className="qn-scroll mb-2 max-h-[min(26dvh,9rem)] overflow-y-auto" aria-label="待发送的消息">
          {queue.map((message, index) => (
            <li key={message.id} className="flex items-center gap-2 border-t border-qn-border text-sm">
              <span className="min-w-0 flex-1 truncate">{message.text.trim() || '附件或引用'}</span>
              {message.sending || message.saving ? <Badge>{message.saving ? '保存中' : '发送中'}</Badge> : (
                <>
                  {running && canSteer && (
                    <Button variant="ghost" className="shrink-0 px-2 text-xs" disabled={!connected}
                      onClick={() => void steer(message.id)}>引导</Button>
                  )}
                  <Button variant="ghost" className="shrink-0 px-2 text-xs" onClick={() => {
                    if (unlock.current) return
                    const release = beginEdit(message.id)
                    if (!release) return
                    unlock.current = release
                    setEditError(false)
                    setEdit({ id: message.id, text: message.text })
                  }}>重新编辑</Button>
                  <Button variant="ghost" className="qn-icon-button" aria-label={`移除排队消息 ${index + 1}`} onClick={() => remove(message.id)}>
                    <X size={16} aria-hidden />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>
      {edit && edited && (
        <Dialog title="重新编辑排队消息" onClose={() => { if (!saving) closeEditor() }}>
          <form onSubmit={(event) => { event.preventDefault(); void submitEdit() }}>
            <textarea className="qn-input w-full resize-y" aria-label="排队消息正文" rows={4} value={edit.text}
              onChange={(event) => setEdit({ ...edit, text: event.target.value })} disabled={saving} />
            {editError && <Note tone="error" message="无法保存修改，请检查消息大小或手机存储后重试。" />}
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" disabled={saving} onClick={closeEditor}>取消</Button>
              <Button type="submit" variant="primary" disabled={saving || edit.text === edited.text ||
                !(edit.text.trim() || edited.attachments.length || edited.annotations.length)}>保存</Button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  )
}
