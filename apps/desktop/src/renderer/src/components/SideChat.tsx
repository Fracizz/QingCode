import { useLayoutEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ApprovalDecision, ItemView, RequestId } from '@qn/codex-client'
import { DEFAULT_AGENT, sessionKey } from '../lib/agents'
import { buildAnnotatedMessage } from '../lib/annotations'
import { isAtBottom } from '../lib/diff'
import { hasPendingSubmission } from '../lib/turnGroups'
import { pendingSendKey, useCodex } from '../store/codex'
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
  const sideOpen = useCodex((s) => s.sideOpen)
  const sideTargetId = useCodex((s) => s.sideTargetId)
  const sideAgent = useCodex((s) => s.sideAgent)
  const sideThreadId = useCodex((s) => s.sideThreadId)
  const sideDraft = useCodex((s) => s.sideDraft)
  const sideError = useCodex((s) => s.sideError)
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
  const sendingQueued = useCodex((s) => !!(chatKey && s.pendingSends[chatKey]?.[0]?.sending))
  const view = sideThreadId ? session?.state.threads[sideThreadId] : undefined
  const preview = sendingMessage?.preview
  const items: ItemView[] = preview ? [...(view?.items ?? []), preview] : view?.items ?? []
  const approvals = view?.pendingApprovals ?? []
  const running = view?.status === 'running'
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
      <div className="flex shrink-0 items-center gap-2 border-b border-qn-border px-3 py-2 text-ui-sm">
        <AgentIcon agent={agent} size={14} />
        <span className="font-medium">侧边临时会话</span>
        <Badge tone="muted">不进入会话列表</Badge>
        <IconButton label="关闭侧边聊天" size="sm" className="ml-auto" onClick={closeSideChat}>
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
          <EmptyState>临时会话已就绪，输入框里已填入引用文字。</EmptyState>
        )}
        <div className="space-y-3">
          <SubagentRpcContext.Provider key={chatKey ?? undefined} value={session?.rpc ?? null}>
            {items.map((item) => (
              <MessageItem
                key={`${sideThreadId}:${item.id}`}
                item={item}
                onEdit={sideThreadId ? (text, input) => {
                  pinned.current = true
                  return send(text, { targetId: sideTargetId, agent: sideAgent, threadId: sideThreadId, input })
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
      <SendQueue targetId={sideTargetId} agent={agent} threadId={sideThreadId} running={running} compact />
      <Composer
        compact
        onSend={(text, mode) => {
          pinned.current = true
          void sendSide(text, mode)
        }}
        onInterrupt={() => void interruptSide()}
        running={running}
        sending={sending}
        disabled={!sideThreadId}
        error={sideError}
        onClearError={clearSideError}
        value={sideDraft}
        onChange={setSideDraft}
        agent={agent}
      />
    </aside>
  )
}
