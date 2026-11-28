import {
  AGENT_CAPABILITIES, isSlashDraft, resolveAccessMode, sessionAccessOptions, type SessionAccessSelection, t, translateMessage,
} from '@qn/codex-client'
import { CornerDownRight, GitBranch, ListOrdered, MessageSquarePlus, MoreHorizontal, Pencil, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { UNCONFIRMED_QUEUED_SEND } from '../queuedSends'
import { selectedAccessPreference, selectedQueuedSends, useApp, type QueuedThreadMode } from '../store'
import { MODE_ICONS } from './AccessModePicker'
import { Badge, Button, Dialog, Note, SheetAction } from './ui'

const newChatActions = [
  { mode: 'start', label: t('新会话开始'), Icon: MessageSquarePlus },
  { mode: 'continue', label: t('新对话继续'), Icon: GitBranch },
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
  const insert = useApp((state) => state.interruptQueuedSend)
  const sendInNewThread = useApp((state) => state.sendQueuedInNewThread)
  const agent = useApp((state) => state.selectedAgent)
  const canContinue = AGENT_CAPABILITIES[agent].fork
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState(false)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
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
        setMoveError(useApp.getState().error ?? t('暂时无法在新会话发送，请重试。'))
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
  const destinationTitle = continuing ? t('新对话继续') : t('新会话开始')
  const destinationError = moveError ?? (movingMessage?.error === UNCONFIRMED_QUEUED_SEND ? movingMessage.error : null)
  const accessOption = (selection?: SessionAccessSelection) => {
    const mode = resolveAccessMode(agent, globalAccessMode, selection)
    return mode !== 'default' ? sessionAccessOptions(agent).find((option) => option.mode === mode) : undefined
  }
  const accessLabel = (selection?: SessionAccessSelection) => accessOption(selection)?.label
  const actionMessage = queue.find((item) => item.id === actionsFor)
  // 引导的条件：本轮运行中、可引导、且不是斜杠命令（命令只能作为独立一轮发送）。
  const steerable = (message: (typeof queue)[number]) => running && canSteer
    && !isSlashDraft(agent, message.text, message.attachments.filter((item) => item.type === 'skill').length)
  const startEdit = (id: string, text: string) => {
    if (unlock.current) return
    const release = beginEdit(id)
    if (!release) return
    unlock.current = release
    setEditError(false)
    setEdit({ id, text })
  }
  return (
    <section className="qn-queue" aria-label={t('发送队列')}>
      <details className="qn-details qn-queue-details" open>
        <summary>
          <ListOrdered size={15} className="mr-1.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{queue.length === 1 ? t('1 条消息排队') : t('{count} 条消息排队', { count: queue.length })}</span>
          {first?.error && <Badge tone="warn">{t('已暂停')}</Badge>}
          {!first?.error && !connected && <Badge tone="warn">{t('等待重连')}</Badge>}
        </summary>
        {first?.error && (
          <div className="mb-1 flex items-center gap-2 text-xs text-qn-warn">
            <span className="min-w-0 flex-1 wrap-anywhere">{translateMessage(first.error)}</span>
            <Button variant="ghost" className="shrink-0 px-2 text-xs" disabled={!connected || running || first.sending || first.saving} onClick={() => void retry()}>{t('继续发送')}</Button>
          </div>
        )}
        <ul className="qn-scroll qn-queue-list" aria-label={t('待发送的消息')}>
          {queue.map((message, index) => {
            const access = accessOption(accessPreference ?? message.accessMode)
            const AccessIcon = access ? MODE_ICONS[access.mode] : null
            return (
              <li key={message.id} className="qn-queue-item">
                {/* 访问模式与输入框一致只用盾牌图标，档位名留给读屏。 */}
                {access && AccessIcon && (
                  <AccessIcon size={14} strokeWidth={1.9} role="img" aria-label={access.label}
                    className={`shrink-0 ${access.warning ? 'text-qn-danger' : 'text-qn-warn'}`} />
                )}
                <p className="min-w-0 flex-1 truncate">{message.text.trim() || t('附件或引用')}</p>
                {message.sending || message.saving ? <Badge>{message.saving ? t('保存中') : t('发送中')}</Badge> : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {steerable(message) && (
                      <Button variant="ghost" className="qn-queue-steer" disabled={!connected}
                        title={agent === 'claude' ? t('本轮结束时可能进入下一轮') : t('补充到当前一轮')}
                        onClick={() => void steer(message.id)}>{t('引导')}</Button>
                    )}
                    <Button variant="ghost" className="qn-icon-button" aria-label={t('更多操作')} aria-haspopup="dialog"
                      onClick={() => setActionsFor(message.id)}>
                      <MoreHorizontal size={17} aria-hidden />
                    </Button>
                    <Button variant="ghost" className="qn-icon-button" aria-label={t('移除排队消息 {index}', { index: index + 1 })} onClick={() => remove(message.id)}>
                      <X size={16} aria-hidden />
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </details>
      {/* 低频操作收进底部面板：一行只留引导、更多、移除，正文不再被挤成几个字。 */}
      {actionMessage && (
        <Dialog title={t('排队消息')} onClose={() => setActionsFor(null)}>
          <blockquote className="qn-sheet-quote">{actionMessage.text.trim() || t('附件或引用')}</blockquote>
          {/* 与项目工具菜单同一套轻量动作行：操作项只是选择，不需要卡片套卡片和进入箭头。 */}
          <div className="qn-sheet-actions">
            {/* 引导（默认）：不打断，补进正在运行的一轮；插入：打断当前一轮后立即发送。 */}
            {steerable(actionMessage) && (
              <SheetAction icon={CornerDownRight} disabled={!connected}
                onClick={() => { setActionsFor(null); void steer(actionMessage.id) }}>{t('引导')}</SheetAction>
            )}
            {running && !actionMessage.sending && (
              <SheetAction icon={Zap} disabled={!connected}
                onClick={() => { setActionsFor(null); void insert(actionMessage.id) }}>{t('插入')}</SheetAction>
            )}
            {newChatActions.map(({ mode, label, Icon }) => (
              <SheetAction key={mode} icon={Icon} onClick={() => { setActionsFor(null); chooseDestination(actionMessage.id, mode) }}>{label}</SheetAction>
            ))}
            <SheetAction icon={Pencil} onClick={() => { setActionsFor(null); startEdit(actionMessage.id, actionMessage.text) }}>{t('重新编辑')}</SheetAction>
          </div>
        </Dialog>
      )}
      {edit && edited && (
        <Dialog title={t('重新编辑排队消息')} onClose={() => { if (!saving) closeEditor() }}>
          <form onSubmit={(event) => { event.preventDefault(); void submitEdit() }}>
            <textarea className="qn-input w-full resize-y" aria-label={t('排队消息正文')} rows={4} value={edit.text}
              onChange={(event) => setEdit({ ...edit, text: event.target.value })} disabled={saving} />
            {editError && <Note tone="error" message={t('无法保存修改，请检查消息大小或手机存储后重试。')} />}
            <div className="mt-2 flex justify-end gap-2">
              <Button type="button" disabled={saving} onClick={closeEditor}>{t('取消')}</Button>
              <Button type="submit" variant="primary" disabled={saving || edit.text === edited.text ||
                !(edit.text.trim() || edited.attachments.length || edited.annotations.length)}>{t('保存')}</Button>
            </div>
          </form>
        </Dialog>
      )}
      {destination && (
        <Dialog title={destinationTitle} onClose={closeDestination}>
          <p className="mb-2 text-sm text-qn-muted">
            {continuing
              ? canContinue ? t('继承已结束轮次的上下文，在新会话里发送这条消息。') : t('当前会话不支持创建分支')
              : t('从空白会话开始，用这条消息作为第一条消息。')}
          </p>
          {movingMessage ? (
            <p className="mb-3 max-h-24 overflow-auto whitespace-pre-wrap break-words text-sm">
              {movingMessage.text.trim() || t('附件或引用')}
            </p>
          ) : <Note message={t('这条消息已离开队列。')} />}
          {movingMessage && accessLabel(accessPreference ?? movingMessage.accessMode) !== accessLabel('inherit') && (
            <Note message={accessPreference === 'plan' ? t('新会话沿用计划模式。') : t('新会话将继承权限总控。')} tone="warn" />
          )}
          {destinationError && <Note message={destinationError} tone="error" />}
          {!connected && <Note message={t('连接电脑后可发送。')} tone="warn" />}
          <div className="mt-2 flex justify-end gap-2">
            <Button disabled={moving} onClick={closeDestination}>{t('取消')}</Button>
            <Button variant="primary" disabled={!movingMessage || moving || !connected || (continuing && !canContinue)}
              onClick={() => void submitDestination()}>{moving ? t('正在发送…') : t('在新会话发送')}</Button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
