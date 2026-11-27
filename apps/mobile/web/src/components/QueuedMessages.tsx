import { accessOptions, resolveAccessMode, type AccessSelection } from '@qn/codex-client'
import { GitBranch, ListOrdered, MessageSquarePlus, Pencil, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { UNCONFIRMED_QUEUED_SEND } from '../queuedSends'
import { selectedAccessPreference, selectedQueuedSends, useApp, type QueuedThreadMode } from '../store'
import { Badge, Button, Dialog, Note } from './ui'

const newChatActions = [
  { mode: 'start', label: '新会话开始', Icon: MessageSquarePlus },
  { mode: 'continue', label: '新对话继续', Icon: GitBranch },
] as const

export function QueuedMessages({ running, canSteer }: { running: boolean; canSteer: boolean }) {
  const queue = useApp(selectedQueuedSends)
  const accessPreference = useApp(selectedAccessPreference)
  const globalAccessMode = useApp((state) => state.agentSettings?.globalAccessMode)
  const connected = useApp((state) => state.eventsConnected)
  const remove = useApp((state) => state.removeQueuedSend)
  const retry = useApp((state) => state.retryQueuedSend)
  const beginEdit = useApp((state) => state.beginQueuedEdit)
  const saveEdit = useApp((state) => state.editQueuedSend)
  const steer = useApp((state) => state.steerQueuedSend)
  const sendInNewThread = useApp((state) => state.sendQueuedInNewThread)
  const agent = useApp((state) => state.selectedAgent)
  const canContinue = agent === 'codex'
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState(false)
  const [destination, setDestination] = useState<{ id: string; mode: QueuedThreadMode } | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const unlock = useRef<((resume?: boolean) => void) | null>(null)
  useEffect(() => () => unlock.current?.(), [])
  if (!queue?.length) return null

  function closeEditor() {
    unlock.current?.()
    unlock.current = null
    setEdit(null)
  }

  function chooseDestination(id: string, mode: QueuedThreadMode) {
    if (unlock.current) return
    if (mode === 'start' || canContinue) {
      unlock.current = beginEdit(id)
      if (!unlock.current) return
    }
    setMoveError(null)
    setDestination({ id, mode })
  }

  function closeDestination() {
    if (moving) return
    unlock.current?.()
    unlock.current = null
    setDestination(null)
  }

  async function submitDestination() {
    if (!destination || moving) return
    unlock.current?.(false)
    unlock.current = null
    setMoving(true)
    setMoveError(null)
    try {
      if (await sendInNewThread(destination.id, destination.mode)) setDestination(null)
      else {
        unlock.current = beginEdit(destination.id)
        setMoveError(useApp.getState().error ?? '暂时无法在新会话发送，请重试。')
      }
    } finally {
      setMoving(false)
    }
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
  const movingMessage = queue.find((item) => item.id === destination?.id)
  const continuing = destination?.mode === 'continue'
  const destinationTitle = continuing ? '新对话继续' : '新会话开始'
  const destinationError = moveError ?? (movingMessage?.error === UNCONFIRMED_QUEUED_SEND ? movingMessage.error : null)
  const accessLabel = (selection?: AccessSelection) => {
    const mode = resolveAccessMode(agent, globalAccessMode, selection)
    return mode !== 'default' ? accessOptions[agent].find((option) => option.mode === mode)?.label : undefined
  }
  return (
    <section className="shrink-0 border-t border-qn-border bg-qn-panel px-3" aria-label="发送队列">
      <details className="qn-details" open>
        <summary>
          <ListOrdered size={16} className="mr-1.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{queue.length} 条消息排队</span>
          {first?.error && <Badge tone="warn">已暂停</Badge>}
          {!first?.error && !connected && <Badge tone="warn">等待重连</Badge>}
        </summary>
        {first?.error && (
          <div className="mb-1 flex items-center gap-2 text-xs text-qn-warn">
            <span className="min-w-0 flex-1 wrap-anywhere">{first.error}</span>
            <Button variant="ghost" className="shrink-0 px-2 text-xs" disabled={!connected || running || first.sending || first.saving} onClick={() => void retry()}>继续发送</Button>
          </div>
        )}
        <ul className="qn-scroll qn-queue-list mb-2 max-h-[min(26dvh,9rem)] overflow-y-auto" aria-label="待发送的消息">
          {queue.map((message, index) => (
            <li key={message.id} className="flex items-center gap-2 border-t border-qn-border text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">{message.text.trim() || '附件或引用'}</p>
                {accessLabel(accessPreference ?? message.accessMode) && (
                  <span className="text-xs text-qn-warn">{accessLabel(accessPreference ?? message.accessMode)}</span>
                )}
              </div>
              {message.sending || message.saving ? <Badge>{message.saving ? '保存中' : '发送中'}</Badge> : (
                <div className="flex shrink-0 items-center">
                  {newChatActions.map(({ mode, label, Icon }) => (
                    <Button key={mode} variant="ghost" className="qn-icon-button"
                      aria-label={label} title={label} onClick={() => chooseDestination(message.id, mode)}>
                      <Icon size={18} aria-hidden />
                    </Button>
                  ))}
                  {running && canSteer && (
                    <Button variant="ghost" className="shrink-0 px-2 text-xs" disabled={!connected}
                      title={agent === 'claude' ? '本轮结束时可能进入下一轮' : '补充到当前一轮'}
                      onClick={() => void steer(message.id)}>引导</Button>
                  )}
                  <Button variant="ghost" className="qn-icon-button" aria-label="重新编辑" title="重新编辑" onClick={() => {
                    if (unlock.current) return
                    const release = beginEdit(message.id)
                    if (!release) return
                    unlock.current = release
                    setEditError(false)
                    setEdit({ id: message.id, text: message.text })
                  }}><Pencil size={16} aria-hidden /></Button>
                  <Button variant="ghost" className="qn-icon-button" aria-label={`移除排队消息 ${index + 1}`} onClick={() => remove(message.id)}>
                    <X size={16} aria-hidden />
                  </Button>
                </div>
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
      {destination && (
        <Dialog title={destinationTitle} onClose={closeDestination}>
          <p className="mb-2 text-sm text-qn-muted">
            {continuing
              ? canContinue ? '继承已结束轮次的上下文，在新会话里发送这条消息。' : '当前仅 Codex 支持继承会话上下文。'
              : '从空白会话开始，用这条消息作为第一条消息。'}
          </p>
          {movingMessage ? (
            <p className="mb-3 max-h-24 overflow-auto whitespace-pre-wrap break-words text-sm">
              {movingMessage.text.trim() || '附件或引用'}
            </p>
          ) : <Note message="这条消息已离开队列。" />}
          {movingMessage && accessLabel(accessPreference ?? movingMessage.accessMode) !== accessLabel('inherit') && (
            <Note message="新会话将继承权限总控。" tone="warn" />
          )}
          {destinationError && <Note message={destinationError} tone="error" />}
          {!connected && <Note message="连接电脑后可发送。" tone="warn" />}
          <div className="mt-2 flex justify-end gap-2">
            <Button disabled={moving} onClick={closeDestination}>取消</Button>
            <Button variant="primary" disabled={!movingMessage || moving || !connected || (continuing && !canContinue)}
              onClick={() => void submitDestination()}>{moving ? '正在发送…' : '在新会话发送'}</Button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
