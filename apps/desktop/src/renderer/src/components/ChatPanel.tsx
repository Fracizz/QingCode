import { useEffect, useRef, useState, type UIEvent } from 'react'
import { ArrowDown } from 'lucide-react'
import type { ApprovalDecision, ApprovalView, ItemView, RequestId } from '@qn/codex-client'
import { buildAnnotatedMessage, quoteBlock, type Annotation } from '../lib/annotations'
import { sessionKey } from '../lib/agents'
import { isAtBottom } from '../lib/diff'
import type { Box } from '../lib/selection'
import { useCodex } from '../store/codex'
import { useProjects } from '../store/projects'
import { useTargets } from '../store/targets'
import { AgentIcon } from './AgentIcon'
import { AnnotationBar } from './AnnotationBar'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { MessageItem } from './MessageItem'
import { RateLimitBadge } from './RateLimitBadge'
import { SelectionLayer } from './SelectionLayer'
import { SideChat } from './SideChat'
import { Badge, EmptyState, ErrorNote } from './ui'

function stateBadge(status: string | undefined) {
  if (status === 'running') return <Badge tone="accent">运行中</Badge>
  if (status === 'error') return <Badge tone="danger">失败</Badge>
  return <Badge tone="ok">就绪</Badge>
}

export function ChatPanel() {
  const targets = useTargets((s) => s.targets)
  const sessions = useCodex((s) => s.sessions)
  const currentTargetId = useCodex((s) => s.currentTargetId)
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentAgent = useCodex((s) => s.currentAgent)
  const threads = useCodex((s) => s.threads)
  const sending = useCodex((s) => s.sending)
  const error = useCodex((s) => s.error)
  const clearError = useCodex((s) => s.clearError)
  const send = useCodex((s) => s.send)
  const interrupt = useCodex((s) => s.interrupt)
  const respondApproval = useCodex((s) => s.respondApproval)
  const ensureOpen = useCodex((s) => s.ensureOpen)
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const openSideChat = useCodex((s) => s.openSideChat)
  const newThread = useCodex((s) => s.newThread)
  const selectedProjectId = useProjects((s) => s.selectedId)
  const projects = useProjects((s) => s.projects)

  const scrollRef = useRef<HTMLDivElement>(null)
  const annotationCounter = useRef(0)
  const [pinned, setPinned] = useState(true)
  const [draft, setDraft] = useState('')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [highlights, setHighlights] = useState<Record<string, Box[]>>({})

  const session = currentTargetId
    ? sessions[sessionKey(currentTargetId, currentAgent)]
    : undefined
  const view = currentThreadId ? session?.state.threads[currentThreadId] : undefined
  const items: ItemView[] = view?.items ?? []
  const approvals: ApprovalView[] = view
    ? view.pendingApprovals
    : Object.values(session?.state.threads ?? {}).flatMap((thread) => thread.pendingApprovals)
  const running = view?.status === 'running'

  const lastItem = items[items.length - 1]
  const signature = `${items.length}:${approvals.length}:${
    lastItem?.kind === 'agent'
      ? lastItem.text.length
      : lastItem?.kind === 'command'
        ? lastItem.output.length
        : lastItem?.kind === 'reasoning'
          ? lastItem.summary.length
          : lastItem?.kind === 'fileChange'
            ? lastItem.changes.reduce((total, change) => total + (change.diff?.length ?? 0), 0)
            : lastItem?.kind === 'other'
              ? lastItem.summary.length
              : 0
  }`

  useEffect(() => {
    if (pinned && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [signature, pinned])

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget
    setPinned(isAtBottom(node.scrollTop, node.scrollHeight, node.clientHeight))
  }

  const scrollToBottom = () => {
    setPinned(true)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }

  const addAnnotation = (quote: string, comment: string, boxes: Box[]) => {
    annotationCounter.current += 1
    const id = `annotation-${annotationCounter.current}`
    setAnnotations((prev) => [...prev, { id, quote, comment }])
    setHighlights((prev) => ({ ...prev, [id]: boxes }))
  }

  const removeAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((item) => item.id !== id))
    setHighlights((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const submit = (text: string) => {
    const message = buildAnnotatedMessage(annotations, text)
    if (!message.trim()) return
    void send(message)
    setAnnotations([])
    setHighlights({})
  }

  const forkFromMessage = (markdown: string) => {
    void (async () => {
      await newThread(currentAgent)
      setDraft(quoteBlock(markdown))
    })()
  }

  const targetName = targets.find((target) => target.id === currentTargetId)?.name ?? '未选择目标'
  const projectName = projects.find((project) => project.id === selectedProjectId)?.name
  const threadTitle = threads.find(
    (thread) => thread.id === currentThreadId && thread.agent === currentAgent,
  )?.title

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-qn-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-qn-border px-5 py-3 text-xs">
        <span className="font-medium">{targetName}</span>
        {projectName && <span className="text-qn-muted">/ {projectName}</span>}
        {threadTitle && <span className="min-w-0 truncate text-qn-muted">/ {threadTitle}</span>}
        <span className="ml-auto flex items-center gap-2">
          <AgentIcon agent={currentAgent} label />
          <RateLimitBadge targetId={currentTargetId} agent={currentAgent} threadId={currentThreadId} />
          {currentThreadId ? stateBadge(view?.status) : <Badge tone="muted">未打开会话</Badge>}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <SelectionLayer
          containerRef={scrollRef}
          className="qn-scroll h-full overflow-y-auto px-5 py-4"
          onScroll={onScroll}
          highlights={Object.values(highlights).flat()}
          onAdd={addAnnotation}
          onSide={(quote) => void openSideChat(quote)}
        >
          {session?.openError && (
            <div className="mb-3">
              <ErrorNote
                message={session.openError}
                onRetry={() => {
                  if (currentTargetId) {
                    void ensureOpen(currentTargetId, currentAgent).then(() => void refreshThreads())
                  }
                }}
              />
            </div>
          )}
          {view?.error && (
            <div className="mb-3">
              <ErrorNote message={`Turn 失败：${view.error}`} />
            </div>
          )}
          {items.length === 0 && approvals.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <EmptyState>
                {currentThreadId
                  ? '会话暂无消息，发送一条开始对话。'
                  : '选择已有会话或新建会话；也可以直接输入消息创建会话。'}
              </EmptyState>
            </div>
          )}
          <div className="mx-auto max-w-3xl space-y-3">
            {items.map((item) => (
              <MessageItem key={item.id} item={item} onFork={forkFromMessage} />
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
        {!pinned && (
          <button
            type="button"
            className="absolute bottom-4 right-6 flex items-center gap-1 rounded-full border border-qn-border bg-qn-panel px-3 py-1.5 text-xs shadow-lg hover:bg-white/10"
            onClick={scrollToBottom}
          >
            <ArrowDown size={13} /> 回到底部
          </button>
        )}
      </div>

      <AnnotationBar annotations={annotations} onRemove={removeAnnotation} />
      <Composer
        onSend={submit}
        onInterrupt={() => void interrupt()}
        running={running}
        sending={sending}
        disabled={!currentTargetId}
        error={error}
        onClearError={clearError}
        value={draft}
        onChange={setDraft}
        agent={currentAgent}
        annotationCount={annotations.length}
      />
      <SideChat />
    </main>
  )
}
