import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, MessagesSquare, PanelRightClose, Quote, X } from 'lucide-react'
import type { ItemView } from '@qn/codex-client'
import { t } from '@qn/codex-client'
import { agentLabel, DEFAULT_AGENT, sessionKey } from '../lib/agents'
import { annotationExcerpt, type Annotation } from '../lib/annotations'
import { isAtBottom } from '../lib/diff'
import { SIDE_CHAT_DEFAULT_WIDTH, sideChatLayout } from '../lib/layout'
import { hasPendingSubmission, streamingReplyId, turnTimeline } from '../lib/turnGroups'
import { currentSideApprovals, currentSideChat, pendingSendKey, currentChatKey, useCodex } from '../store/codex'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { MessageItem, TurnProgress, TurnStopped } from './MessageItem'
import { ResizeHandle } from './ResizeHandle'
import { SelectionLayer } from './SelectionLayer'
import { SendQueue } from './SendQueue'
import { SubagentRpcContext } from './SubagentDetails'
import { TurnErrorNote } from './TurnErrorNote'
import { ErrorNote, IconButton } from './ui'

export function SideChat() {
  const ownerKey = useCodex(currentChatKey)
  const side = useCodex(currentSideChat)
  const sideOpen = side?.open
  const sideTargetId = side?.targetId
  const sideAgent = side?.agent
  const sideThreadId = side?.threadId ?? null
  const sideDraft = side?.draft ?? ''
  const sideError = side?.error
  const endSideChat = useCodex((s) => s.endSideChat)
  const sending = useCodex((s) => s.sending)
  const setSideDraft = useCodex((s) => s.setSideDraft)
  const addSideAnnotation = useCodex((s) => s.addSideAnnotation)
  const editSideAnnotation = useCodex((s) => s.editSideAnnotation)
  const removeSideAnnotation = useCodex((s) => s.removeSideAnnotation)
  const clearSideError = useCodex((s) => s.clearSideError)
  const sendSide = useCodex((s) => s.sendSide)
  const send = useCodex((s) => s.send)
  const closeSideChat = useCodex((s) => s.closeSideChat)
  const interruptSide = useCodex((s) => s.interruptSide)
  const respondApproval = useCodex((s) => s.respondApproval)
  const panelRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [preferredWidth, setPreferredWidth] = useState(SIDE_CHAT_DEFAULT_WIDTH)
  const [availableWidth, setAvailableWidth] = useState(SIDE_CHAT_DEFAULT_WIDTH + 48)
  const { docked, min, max, width } = sideChatLayout(preferredWidth, availableWidth)

  // 只订阅侧聊所在会话，其他会话的流式增量不触发重渲染。
  const session = useCodex((s) => sideTargetId && sideAgent ? s.sessions[sessionKey(sideTargetId, sideAgent)] : undefined)
  const chatKey = sideTargetId && sideAgent && sideThreadId && pendingSendKey({ targetId: sideTargetId, agent: sideAgent, threadId: sideThreadId })
  const sendingMessage = useCodex((s) => s.sendingMessage?.key === chatKey ? s.sendingMessage : null)
  const queueLength = useCodex((s) => chatKey ? s.pendingSends[chatKey]?.length : 0)
  const sendingQueued = useCodex((s) => !!(chatKey && s.pendingSends[chatKey]?.[0]?.sending))
  const view = sideThreadId ? session?.state.threads[sideThreadId] : undefined
  const preview = sendingMessage?.preview
  const items: ItemView[] = useMemo(() => preview ? [...(view?.items ?? []), preview] : view?.items ?? [], [preview, view?.items])
  const timeline = useMemo(() => turnTimeline(items, view?.turns), [items, view?.turns])
  const approvals = useCodex(currentSideApprovals)
  const running = !side?.expired && view?.status === 'running'
  const streamingId = running ? streamingReplyId(view) : undefined
  const interrupted = !running && view?.activity === 'interrupted'
  const showProgress = approvals.length === 0 && !session?.openError
    && (running || hasPendingSubmission(items, !!sendingMessage || sendingQueued))
  const agent = sideAgent ?? DEFAULT_AGENT

  useLayoutEffect(() => {
    const container = panelRef.current?.parentElement
    if (!container) return
    const measure = () => setAvailableWidth(container.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [sideOpen])

  useLayoutEffect(() => { pinned.current = true }, [ownerKey, sideOpen, sideThreadId])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (scroll && pinned.current) scroll.scrollTop = scroll.scrollHeight
  }, [ownerKey, sideOpen, sideThreadId, timeline, approvals, showProgress, width])

  if (!sideOpen || !sideTargetId || !sideAgent) return null

  const status = side.expired ? t('会话已结束') : approvals.length ? t('等待审批') : running ? t('正在运行') : side.busy ? t('正在发送') : null
  const showWelcome = timeline.length === 0 && approvals.length === 0 && !showProgress && !side.expired && !side.busy && !session?.openError
  const annotationCount = side.annotations.filter((annotation) => annotation.quote.trim()).length

  return (
    <aside
      ref={panelRef}
      aria-label={t('侧边对话')}
      className={`${docked ? 'relative' : 'absolute inset-y-0 right-0 shadow-2xl'} qn-side-chat z-20 flex min-h-0 max-w-full shrink-0 flex-col border-l border-qn-border-strong bg-qn-panel [container-type:size]`}
      style={{ width }}
    >
      {max > min && (
        <ResizeHandle
          orientation="vertical"
          direction={-1}
          value={width}
          min={min}
          max={max}
          onChange={setPreferredWidth}
          onReset={() => setPreferredWidth(SIDE_CHAT_DEFAULT_WIDTH)}
          label={t('调整侧边对话宽度（双击复位）')}
          className="absolute inset-y-0 -left-[5px]"
        />
      )}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-qn-border px-3.5 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-qn-border-strong bg-qn-elevated text-qn-text">
          <MessagesSquare size={16} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-ui-md font-medium text-qn-text">{t('侧边对话')}</h2>
          <p className="truncate text-ui-sm text-qn-muted" role="status" title={status ?? undefined}>
            {agentLabel(agent)} · {status ?? t('临时会话')}
          </p>
        </div>
        <IconButton label={t('收起侧边对话')} tooltipSide="bottom" onClick={closeSideChat}>
          <PanelRightClose size={16} />
        </IconButton>
        <IconButton label={t('结束侧边对话')} tooltipSide="bottom" disabled={side.busy || running || !!queueLength || approvals.length > 0} onClick={() => void endSideChat()}>
          <X size={16} />
        </IconButton>
      </header>
      {session?.openError && (
        <div className="px-3 pt-2"><ErrorNote message={session.openError} /></div>
      )}
      {!running && !interrupted && view?.error && (
        <div className="px-3 pt-2"><TurnErrorNote error={view.error} compact /></div>
      )}
      <SelectionLayer
        layoutKey={JSON.stringify([ownerKey, sideThreadId, width])}
        containerRef={scrollRef}
        className="qn-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-gutter:stable_both-edges]"
        onScroll={({ currentTarget }) => {
          pinned.current = isAtBottom(currentTarget.scrollTop, currentTarget.scrollHeight, currentTarget.clientHeight)
        }}
        showSideAction={false}
        onSide={() => undefined}
        onAdd={addSideAnnotation}
      >
        {showWelcome && (
          <div className="grid min-h-full place-items-center py-3 text-center">
            <div className="max-w-64">
              <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl border border-qn-border-strong bg-qn-elevated text-qn-muted">
                <Quote size={19} aria-hidden />
              </span>
              <p className="text-ui-md font-medium text-qn-text">{t('接着聊一个细节')}</p>
              <p className="mt-1.5 text-ui leading-5 text-qn-muted">
                {annotationCount ? t('下方的引用会随问题发送。') : t('也可以在主对话选中文字，引用到这里。')}
              </p>
            </div>
          </div>
        )}
        <div className="space-y-3">
          <SubagentRpcContext.Provider key={chatKey || undefined} value={session?.rpc ?? null}>
            {timeline.map((entry) => entry.kind === 'stopped' ? (
              <TurnStopped key={entry.key} durationMs={entry.durationMs} />
            ) : (
              <MessageItem
                key={`${sideThreadId}:${entry.key}`}
                item={entry.item}
                showStreamingDots={entry.item.id === streamingId}
                onEdit={sideThreadId && !side.expired && !side.busy ? (text, input) => {
                  pinned.current = true
                  return send(text, { targetId: sideTargetId, agent: sideAgent, threadId: sideThreadId, input, sideKey: ownerKey })
                } : undefined}
              />
            ))}
          </SubagentRpcContext.Provider>
          {showProgress && <TurnProgress activity={running ? view.activity : undefined} />}
          {sideThreadId && approvals.map((approval) => (
            <ApprovalCard
              key={String(approval.requestId)}
              approval={approval}
              onDecide={(decision) => respondApproval(
                { targetId: sideTargetId, agent: sideAgent, threadId: sideThreadId },
                approval.requestId, decision,
              )}
            />
          ))}
        </div>
      </SelectionLayer>
      <div className="shrink-0 border-t border-qn-border pt-2">
        <SendQueue targetId={sideTargetId} agent={agent} threadId={sideThreadId} running={running} resumeDisabled={side.expired} compact />
        {side.expired && (
          <button type="button" className="qn-button-subtle mx-3 mb-2 text-ui-md" disabled={side.busy || sendingQueued}
            onClick={() => void useCodex.getState().restartSideChat()}>
            {t('重新开始侧聊')}
          </button>
        )}
        <Composer
          key={ownerKey}
          compact
          autoFocus
          placeholder={t('继续追问…')}
          annotationCount={annotationCount}
          context={side.annotations.length > 0 && (
            <ul aria-label={t('引用上下文')} className="qn-scroll max-h-[min(8rem,22cqh)] space-y-1.5 overflow-y-auto px-2.5 pt-2.5">
              {side.annotations.map((annotation) => (
                <SideQuote
                  key={annotation.id}
                  annotation={annotation}
                  disabled={side.busy}
                  onEdit={(quote) => editSideAnnotation(annotation.id, quote)}
                  onRemove={() => removeSideAnnotation(annotation.id)}
                />
              ))}
            </ul>
          )}
          toolsDisabled={agent === 'pi'}
          onSend={(text, mode) => {
            pinned.current = true
            void sendSide(text, mode)
          }}
          onInterrupt={() => void interruptSide()}
          running={running}
          sending={sending || side.busy}
          disabled={side.expired || side.busy}
          error={sideError ?? null}
          onClearError={clearSideError}
          value={sideDraft}
          onChange={setSideDraft}
          agent={agent}
        />
      </div>
    </aside>
  )
}

function SideQuote({ annotation, disabled, onEdit, onRemove }: {
  annotation: Annotation
  disabled: boolean
  onEdit: (quote: string) => void
  onRemove: () => void
}) {
  const excerpt = annotationExcerpt(annotation) || t('空引用')
  return (
    <li className="relative rounded-lg border border-qn-border-strong bg-qn-panel">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-2 pl-2.5 pr-9 text-ui-sm text-qn-muted hover:text-qn-text focus-visible:outline-2 focus-visible:outline-qn-accent [&::-webkit-details-marker]:hidden">
          <Quote size={13} className="shrink-0" aria-hidden />
          <span className="shrink-0 font-medium text-qn-text">{t('引用')}</span>
          <span className="flex-1 truncate">{excerpt}</span>
          <ChevronDown size={13} className="ml-auto shrink-0 group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-qn-border p-2">
          <textarea
            aria-label={t('编辑引用文字')}
            className="qn-input qn-scroll block max-h-24 min-h-10 resize-none bg-qn-panel [field-sizing:content]"
            value={annotation.quote}
            disabled={disabled}
            onChange={(event) => onEdit(event.target.value)}
          />
          {annotation.comment && <p className="mt-1.5 whitespace-pre-wrap text-ui text-qn-muted [overflow-wrap:anywhere]">{annotation.comment}</p>}
        </div>
      </details>
      <IconButton label={t('移除引用 {excerpt}', { excerpt })} size="sm" tooltip={false} className="absolute top-1 right-1" disabled={disabled} onClick={onRemove}>
        <X size={13} />
      </IconButton>
    </li>
  )
}
