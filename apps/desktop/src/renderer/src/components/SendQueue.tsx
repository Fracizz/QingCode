import type { UserInput } from '@qn/codex-client'
import { CornerDownRight, FileText, GitBranch, Image as ImageIcon, ListEnd, MessageSquarePlus, PanelRightOpen, Pencil, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { t, translateMessage } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { isAbsolutePath, joinPath } from '../features/files/fileLinks'
import { openFile } from '../features/workspace/openers'
import { sessionKey } from '../lib/agents'
import { basename } from '../lib/attachments'
import { pendingSendKey, useCodex } from '../store/codex'
import { canContinueQueued, type PendingThreadMode } from '../store/pendingQueue'
import { MessageImage } from './MessageImage'
import { IconButton, Modal } from './ui'

function attachmentPreviews(input: readonly UserInput[], targetId: string, cwd: string | null) {
  let imageCount = 0
  return input.flatMap((entry, index) => {
    if (entry.type === 'image' && 'url' in entry && entry.url.startsWith('data:image/')) {
      return <MessageImage key={index} src={entry.url} label={`${t('图片')} ${++imageCount}`} compact />
    }
    if (entry.type !== 'mention' && entry.type !== 'skill' && entry.type !== 'localImage' && entry.type !== 'localAudio') return []

    const Icon = entry.type === 'skill' ? Wand2 : entry.type === 'localImage' ? ImageIcon : FileText
    const name = 'name' in entry ? entry.name : basename(entry.path)
    const label = `${entry.type === 'skill' ? t('查看技能') : t('打开附件')} ${name}`
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

const startAction = { mode: 'start', label: t('新会话开始'), Icon: MessageSquarePlus } as const
const continueAction = { mode: 'continue', label: t('新对话继续'), Icon: GitBranch } as const
const sideAction = { mode: 'side', label: t('侧边栏开始'), Icon: PanelRightOpen } as const

/** 能分支的 Agent 在侧边继续当前上下文；Claude / pi 不支持分支，改为在侧边栏开空白侧聊。 */
export function newThreadActions(agent: AgentKind) {
  return [startAction, canContinueQueued(agent) ? continueAction : sideAction]
}

const destinationText = {
  start: { title: t('新会话开始'), description: t('从空白会话开始，用这条消息作为第一条消息。'), submit: t('在新会话发送') },
  continue: { title: t('新对话继续'), description: t('继承最后一个已结束轮次的上下文，在右侧打开分支并发送这条消息。'), submit: t('在侧边栏发送') },
  side: { title: t('侧边栏开始'), description: t('在右侧打开空白侧边对话，用这条消息作为第一条消息；不继承本会话上下文，也不进入会话列表。'), submit: t('在侧边栏发送') },
}

export function SendQueue({
  targetId, agent, threadId, running, resumeDisabled, compact, allowNewThread, contentWidthClassName = 'max-w-3xl',
}: {
  targetId: string | null
  agent: AgentKind
  threadId: string | null
  running: boolean
  resumeDisabled?: boolean
  compact?: boolean
  /** 主对话允许把排队消息移到新会话；侧边对话是临时会话，不提供。 */
  allowNewThread?: boolean
  contentWidthClassName?: string
}) {
  const chat = targetId && threadId ? { targetId, agent, threadId } : null
  const key = chat ? pendingSendKey(chat) : null
  const pending = useCodex((state) => key ? state.pendingSends[key] : undefined)
  const cwd = useCodex((state) => state.currentTargetId === targetId ? state.currentCwd : null)
  const view = useCodex((state) => targetId && threadId
    ? state.sessions[sessionKey(targetId, agent)]?.state.threads[threadId] : undefined)
  const remove = useCodex((state) => state.removePendingSend)
  const retry = useCodex((state) => state.retryPendingSend)
  const hold = useCodex((state) => state.holdPendingSend)
  const saveEdit = useCodex((state) => state.editPendingSend)
  const steer = useCodex((state) => state.steerPendingSend)
  const sendInNewThread = useCodex((state) => state.sendPendingInNewThread)
  const [edit, setEdit] = useState<{ id: number; text: string; error?: boolean } | null>(null)
  const [destination, setDestination] = useState<{ id: number; mode: PendingThreadMode } | null>(null)
  const [moving, setMoving] = useState(false)
  // 编辑或选择新会话期间暂停这条消息的自动发送，关闭弹窗时恢复。
  const release = useRef<((resume?: boolean) => void) | null>(null)
  useEffect(() => () => release.current?.(), [])
  if (!chat || !pending?.length) return null

  const canSteer = running && !!view?.activeTurnId
  const canContinue = canContinueQueued(agent)
  const hasFinishedTurn = !!view?.turns?.some((turn) => turn.outcome)

  const holdItem = (id: number) => {
    if (release.current) return false
    release.current = hold(chat, id)
    return !!release.current
  }
  const releaseItem = (resume = true) => {
    release.current?.(resume)
    release.current = null
  }
  const closeEdit = () => {
    releaseItem()
    setEdit(null)
  }
  const closeDestination = () => {
    if (moving) return
    releaseItem()
    setDestination(null)
  }
  const submitEdit = () => {
    if (!edit) return
    if (saveEdit(chat, edit.id, edit.text)) closeEdit()
    else setEdit({ ...edit, error: true })
  }
  const submitDestination = async () => {
    if (!destination || moving) return
    releaseItem(false)
    setMoving(true)
    try {
      await sendInNewThread(chat, destination.id, destination.mode)
      setDestination(null)
    } finally {
      setMoving(false)
    }
  }

  const edited = pending.find((item) => item.id === edit?.id)
  const moved = pending.find((item) => item.id === destination?.id)
  const continuing = destination?.mode === 'continue'
  const destinationBlocked = continuing && (!canContinue || !hasFinishedTurn)

  return (
    <div className={`shrink-0 ${compact ? 'px-4' : 'px-6'}`}>
      <section
        aria-label={t('发送队列')}
        className={`mx-auto rounded-xl border border-qn-border bg-qn-panel px-3 py-2 text-ui-sm ${contentWidthClassName}`}
      >
        <div className="flex items-center gap-1.5 text-qn-muted"><ListEnd size={14} /> {t('排队消息（{count}）', { count: pending.length })}</div>
        <ul className="qn-scroll mt-1 max-h-32 space-y-0.5 overflow-auto">
          {pending.map((item) => {
            const text = item.text.trim()
            const attachments = attachmentPreviews(item.input, chat.targetId, cwd)
            return (
              <li key={item.id} className="rounded-md bg-qn-elevated px-2">
                <div className="flex min-h-7 items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {(text || !attachments.length) && <span className="min-w-0 truncate" title={text || undefined}>{text || t('附件或技能')}</span>}
                    {attachments.length > 0 && (
                      <div className={`flex shrink-0 flex-wrap gap-1 py-0.5 ${text ? 'max-w-1/2' : 'max-w-full'}`}>
                        {attachments}
                      </div>
                    )}
                  </div>
                  {item.sending && <span role="status" className="shrink-0 text-qn-muted">{t('发送中…')}</span>}
                  {item.error && (
                    <button
                      type="button"
                      disabled={running || resumeDisabled || item.sending}
                      className="shrink-0 rounded px-1 text-qn-accent hover:underline disabled:opacity-40"
                      onClick={() => retry(chat)}
                    >
                      {t('继续发送')}
                    </button>
                  )}
                  {!item.sending && canSteer && (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-qn-accent hover:underline"
                      title={agent === 'claude' ? t('本轮结束时可能进入下一轮') : t('补充到当前一轮')}
                      onClick={() => void steer(chat, item.id)}
                    >
                      <CornerDownRight size={12} aria-hidden />{t('引导')}
                    </button>
                  )}
                  {!item.sending && allowNewThread && newThreadActions(agent).map(({ mode, label, Icon }) => (
                    <IconButton key={mode} label={label} size="sm" onClick={() => {
                      if (holdItem(item.id)) setDestination({ id: item.id, mode })
                    }}>
                      <Icon size={13} />
                    </IconButton>
                  ))}
                  {!item.sending && (
                    <IconButton label={t('重新编辑')} size="sm" onClick={() => {
                      if (holdItem(item.id)) setEdit({ id: item.id, text: item.text })
                    }}>
                      <Pencil size={13} />
                    </IconButton>
                  )}
                  <IconButton label={t('移除排队消息')} size="sm" disabled={item.sending} onClick={() => remove(chat, item.id)}>
                    <X size={13} />
                  </IconButton>
                </div>
                {item.error && <div role="status" className="wrap-anywhere pb-1 text-qn-warn">{translateMessage(item.error)}</div>}
              </li>
            )
          })}
        </ul>
      </section>
      {edit && (
        <Modal
          title={t('重新编辑排队消息')}
          onClose={closeEdit}
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={closeEdit}>{t('取消')}</button>
              <button type="button" className="qn-button disabled:opacity-40" onClick={submitEdit}
                disabled={!edited || edit.text === edited.text}>{t('保存')}</button>
            </div>
          }
        >
          {edited ? (
            <>
              <textarea
                autoFocus
                aria-label={t('排队消息正文')}
                className="qn-input qn-scroll min-h-28 resize-y overflow-x-hidden wrap-anywhere"
                wrap="soft"
                value={edit.text}
                onChange={(event) => setEdit({ id: edit.id, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) submitEdit()
                }}
              />
              <p className="mt-1.5 text-ui-sm text-qn-muted">{t('附件与技能保持不变。')}</p>
              {edit.error && <p role="status" className="mt-1 text-ui-sm text-qn-warn">{t('无法保存：消息为空或超过大小上限。')}</p>}
            </>
          ) : <p className="text-qn-muted">{t('这条消息已离开队列。')}</p>}
        </Modal>
      )}
      {destination && (
        <Modal
          title={destinationText[destination.mode].title}
          description={destinationText[destination.mode].description}
          onClose={closeDestination}
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" disabled={moving} onClick={closeDestination}>{t('取消')}</button>
              <button type="button" className="qn-button disabled:opacity-40" disabled={!moved || moving || destinationBlocked}
                onClick={() => void submitDestination()}>{moving ? t('正在发送…') : destinationText[destination.mode].submit}</button>
            </div>
          }
        >
          {moved ? (
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap wrap-anywhere rounded-lg border border-qn-border bg-qn-inset p-2 text-ui-sm">
              {moved.text.trim() || t('附件或技能')}
            </p>
          ) : <p className="text-qn-muted">{t('这条消息已离开队列。')}</p>}
          {continuing && !canContinue && <p role="status" className="mt-2 text-ui-sm text-qn-warn">{t('当前仅 Codex 支持继承会话上下文。')}</p>}
          {continuing && canContinue && !hasFinishedTurn && (
            <p role="status" className="mt-2 text-ui-sm text-qn-warn">{t('当前还没有已结束的一轮，可用「新会话开始」。')}</p>
          )}
          <p className="mt-2 text-ui-sm text-qn-muted">{t('新会话按权限总控运行，不继承本会话单独设置的访问模式。')}</p>
        </Modal>
      )}
    </div>
  )
}

