import { X } from 'lucide-react'
import type { ApprovalDecision, ItemView, RequestId } from '@qn/codex-client'
import { DEFAULT_AGENT, sessionKey } from '../lib/agents'
import { buildAnnotatedMessage } from '../lib/annotations'
import { useCodex } from '../store/codex'
import { AgentIcon } from './AgentIcon'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'
import { SelectionLayer } from './SelectionLayer'
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
  const closeSideChat = useCodex((s) => s.closeSideChat)
  const interruptSide = useCodex((s) => s.interruptSide)
  const respondApproval = useCodex((s) => s.respondApproval)

  if (!sideOpen || !sideTargetId || !sideAgent) return null
  const session = sessions[sessionKey(sideTargetId, sideAgent)]
  const view = sideThreadId ? session?.state.threads[sideThreadId] : undefined
  const items: ItemView[] = view?.items ?? []
  const approvals = view?.pendingApprovals ?? []
  const running = view?.status === 'running'
  const agent = sideAgent ?? DEFAULT_AGENT

  return (
    <aside className="absolute bottom-0 right-0 top-0 z-20 flex w-[380px] max-w-[92vw] flex-col border-l border-qn-border bg-qn-panel shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-qn-border px-3 py-2 text-xs">
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
      {view?.error && (
        <div className="px-3 pt-2"><ErrorNote message={`Turn 失败：${view.error}`} /></div>
      )}
      <SelectionLayer
        className="qn-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3"
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
        {items.length === 0 && approvals.length === 0 && (
          <EmptyState>临时会话已就绪，输入框里已填入引用文字。</EmptyState>
        )}
        <div className="space-y-3">
          {items.map((item) => (
            <MessageItem key={item.id} item={item} />
          ))}
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
      <Composer
        compact
        onSend={(text) => void sendSide(text)}
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
