import { useLayoutEffect, useRef } from 'react'
import { PanelRightClose, X } from 'lucide-react'
import type { ApprovalDecision, ItemView, RequestId } from '@qn/codex-client'
import { DEFAULT_AGENT, sessionKey } from '../lib/agents'
import { buildAnnotatedMessage } from '../lib/annotations'
import { isAtBottom } from '../lib/diff'
import { hasPendingSubmission, streamingReplyId } from '../lib/turnGroups'
import { currentSideChat, pendingSendKey, currentChatKey, useCodex } from '../store/codex'
import { AgentIcon } from './AgentIcon'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { MessageItem, TurnProgress } from './MessageItem'
import { SelectionLayer } from './SelectionLayer'
import { SendQueue } from './SendQueue'
import { SubagentRpcContext } from './SubagentDetails'
import { TurnErrorNote } from './TurnErrorNote'
import { Badge, EmptyState, ErrorNote, IconButton } from './ui'

let nextAnnotationId = 0

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
  const sessions = useCodex((s) => s.sessions)
  const sending = useCodex((s) => s.sending)
  const setSideDraft = useCodex((s) => s.setSideDraft)
  const clearSideError = useCodex((s) => s.clearSideError)
  const sendSide = useCodex((s) => s.sendSide)
  const send = useCodex((s) => s.send)
  const closeSideChat = useCodex((s) => s.closeSideChat)
  const interruptSide = useCodex((s) => s.interruptSide)
  const respondApproval = useCodex((s) => s.respondApproval)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const session = sideTargetId && sideAgent ? sessions[sessionKey(sideTargetId, sideAgent)] : undefined
  const chatKey = sideTargetId && sideAgent && sideThreadId && pendingSendKey({ targetId: sideTargetId, agent: sideAgent, threadId: sideThreadId })
  const sendingMessage = useCodex((s) => s.sendingMessage?.key === chatKey ? s.sendingMessage : null)
  const queueLength = useCodex((s) => chatKey ? s.pendingSends[chatKey]?.length : 0)
  const sendingQueued = useCodex((s) => !!(chatKey && s.pendingSends[chatKey]?.[0]?.sending))
  const view = sideThreadId ? session?.state.threads[sideThreadId] : undefined
  const preview = sendingMessage?.preview
  const items: ItemView[] = preview ? [...(view?.items ?? []), preview] : view?.items ?? []
  const approvals = side?.expired ? [] : view?.pendingApprovals ?? []
  const running = !side?.expired && view?.status === 'running'
  const streamingId = running ? streamingReplyId(view) : undefined
  const interrupted = !running && view?.activity === 'interrupted'
  const showProgress = approvals.length === 0 && !session?.openError
    && (running || hasPendingSubmission(items, !!sendingMessage || sendingQueued))
  const agent = sideAgent ?? DEFAULT_AGENT

  useLayoutEffect(() => { pinned.current = true }, [sideThreadId])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (scroll && pinned.current) scroll.scrollTop = scroll.scrollHeight
  }, [sideOpen, sideThreadId, view?.items, view?.pendingApprovals, preview, showProgress, interrupted])

  if (!sideOpen || !sideTargetId || !sideAgent) return null

  return (
    <aside className="absolute bottom-0 right-0 top-0 z-20 flex w-[380px] max-w-[92vw] flex-col border-l border-qn-border bg-qn-panel shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-qn-border px-3 py-2 text-xs">
        <AgentIcon agent={agent} size={14} />
        <span className="font-medium">侧边临时会话</span>
        <Badge tone="muted">不进入会话列表</Badge>
        <IconButton label="收起侧边对话" size="sm" className="ml-auto" onClick={closeSideChat}>
          <PanelRightClose size={14} />
        </IconButton>
        <IconButton label="结束侧边对话" size="sm" disabled={side.busy || running || !!(chatKey && queueLength)} onClick={() => void endSideChat()}>
          <X size={14} />
        </IconButton>
      </div>
      {session?.openError && (
        <div className="px-3 pt-2"><ErrorNote message={session.openError} /></div>
      )}
      {!running && !interrupted && view?.error && (
        <div className="px-3 pt-2"><TurnErrorNote error={view.error} compact /></div>
      )}
      <SelectionLayer
        layoutKey={ownerKey + (sideThreadId ?? '')}
        containerRef={scrollRef}
        className="qn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3"
        onScroll={({ currentTarget }) => {
          pinned.current = isAtBottom(currentTarget.scrollTop, currentTarget.scrollHeight, currentTarget.clientHeight)
        }}
        showSideAction={false}
        onSide={() => undefined}
        onAdd={(quote, comment) => {
          nextAnnotationId += 1
          setSideDraft(
            buildAnnotatedMessage(
              [{ id: `side-${nextAnnotationId}`, quote, comment }],
              sideDraft,
            ),
          )
        }}
      >
        {items.length === 0 && approvals.length === 0 && !running && !interrupted && (
          <EmptyState>在这里追问，回复会出现在侧边对话中。</EmptyState>
        )}
        <div className="space-y-3">
          <SubagentRpcContext.Provider key={chatKey ?? undefined} value={session?.rpc ?? null}>
            {items.map((item) => (
              <MessageItem
                key={`${sideThreadId}:${item.id}`}
                item={item}
                showStreamingDots={item.id === streamingId}
                onEdit={sideThreadId && !side.expired && !side.busy ? (text, input) => {
                  pinned.current = true
                  return send(text, { targetId: sideTargetId, agent: sideAgent, threadId: sideThreadId, input, sideKey: ownerKey })
                } : undefined}
              />
            ))}
          </SubagentRpcContext.Provider>
          {showProgress ? <TurnProgress activity={running ? view.activity : undefined} />
            : interrupted && <TurnProgress activity="interrupted" />}
          {approvals.map((approval) => (
            <ApprovalCard
              key={String(approval.requestId)}
              approval={approval}
              onDecide={(decision: ApprovalDecision) =>
                respondApproval(approval.requestId as RequestId, decision)
              }
            />
          ))}
        </div>
      </SelectionLayer>
      <SendQueue targetId={sideTargetId} agent={agent} threadId={sideThreadId} running={running} resumeDisabled={side.expired} compact />
      {side.expired && (
        <button type="button" className="p-2 text-sm text-qn-accent disabled:opacity-50" disabled={side.busy || sendingQueued}
          onClick={() => void useCodex.getState().restartSideChat()}>
          重新开始侧聊
        </button>
      )}
      <Composer
        compact
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
    </aside>
  )
}
