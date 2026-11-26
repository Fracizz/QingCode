import type { ApprovalDecision, ItemView, RequestId } from '@qn/codex-client'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'
import { RateLimitBadge, RateLimitDetails } from './RateLimitView'
import { Badge, Empty, Header, Note } from './ui'

function stateBadge(status: string | undefined) {
  if (status === 'running') return <Badge tone="accent">运行中</Badge>
  if (status === 'error') return <Badge tone="danger">失败</Badge>
  return <Badge tone="ok">就绪</Badge>
}

export function ChatPage() {
  const projects = useApp((s) => s.projects)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedTargetId = useApp((s) => s.selectedTargetId)
  const selectedThreadId = useApp((s) => s.selectedThreadId)
  const sessions = useApp((s) => s.sessions)
  const threads = useApp((s) => s.threads)
  const sending = useApp((s) => s.sending)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const annotations = useApp((s) => s.annotations)
  const goBack = useApp((s) => s.goBack)
  const send = useApp((s) => s.send)
  const interrupt = useApp((s) => s.interrupt)
  const respondApproval = useApp((s) => s.respondApproval)
  const addAnnotation = useApp((s) => s.addAnnotation)
  const updateAnnotation = useApp((s) => s.updateAnnotation)
  const removeAnnotation = useApp((s) => s.removeAnnotation)
  const ensureOpen = useApp((s) => s.ensureOpen)
  const refreshThreads = useApp((s) => s.refreshThreads)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)

  const [quoteDraft, setQuoteDraft] = useState<string | null>(null)
  const [showRate, setShowRate] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const session = selectedTargetId ? sessions[selectedTargetId] : undefined
  const view = selectedThreadId ? session?.state.threads[selectedThreadId] : undefined
  const items: ItemView[] = view?.items ?? []
  const approvals = view
    ? view.pendingApprovals
    : Object.values(session?.state.threads ?? {}).flatMap((thread) => thread.pendingApprovals)
  const running = view?.status === 'running'
  const project = projects.find((item) => item.id === selectedProjectId)
  const threadTitle = threads.find((item) => item.id === selectedThreadId)?.title

  const last = items[items.length - 1]
  const signature = `${items.length}:${approvals.length}:${
    last?.kind === 'agent'
      ? last.text.length
      : last?.kind === 'command'
        ? last.output.length
        : last?.kind === 'reasoning'
          ? last.summary.length
          : last?.kind === 'fileChange'
            ? last.changes.reduce((total, change) => total + (change.diff?.length ?? 0), 0)
            : last?.kind === 'other'
              ? last.summary.length
              : 0
  }`

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [signature])

  return (
    <>
      <Header
        title={threadTitle || project?.name || '对话'}
        subtitle={project?.path}
        onBack={goBack}
        right={
          <>
            <RateLimitBadge targetId={selectedTargetId} onToggle={() => setShowRate((value) => !value)} />
            {stateBadge(view?.status)}
          </>
        }
      />
      <div ref={scrollRef} className="qn-body qn-scroll">
        {error && <Note message={error} tone="error" onClose={clearError} />}
        {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        {showRate && <RateLimitDetails targetId={selectedTargetId} onClose={() => setShowRate(false)} />}
        {session?.openError && (
          <Note
            message={session.openError}
            tone="error"
            actionLabel="重试"
            onAction={() => {
              if (selectedTargetId) void ensureOpen(selectedTargetId).then(() => void refreshThreads())
            }}
          />
        )}
        {view?.error && <Note message={`Turn 失败：${view.error}`} tone="error" />}
        {items.length === 0 && approvals.length === 0 && (
          <Empty>
            {selectedThreadId
              ? '会话暂无消息，发送一条开始对话。'
              : '输入消息即可创建新会话；长按/点击消息下方的「引用」可加入注释。'}
          </Empty>
        )}
        <div className="space-y-3">
          {items.map((item) => (
            <MessageItem key={item.id} item={item} onQuote={setQuoteDraft} />
          ))}
          {approvals.map((approval) => (
            <ApprovalCard
              key={String(approval.requestId)}
              approval={approval}
              onDecide={(decision: ApprovalDecision) => respondApproval(approval.requestId as RequestId, decision)}
            />
          ))}
        </div>
      </div>
      <Composer
        onSend={(text) => void send(text)}
        onInterrupt={() => void interrupt()}
        running={running}
        sending={sending}
        disabled={!selectedTargetId}
        error={error}
        onClearError={clearError}
        annotations={annotations}
        onUpdateAnnotation={updateAnnotation}
        onRemoveAnnotation={removeAnnotation}
        quoteDraft={quoteDraft}
        onConfirmQuote={(quote, comment) => {
          addAnnotation(quote, comment)
          setQuoteDraft(null)
        }}
        onCancelQuote={() => setQuoteDraft(null)}
      />
    </>
  )
}
