import { ArrowDown, ChevronDown, PanelLeft } from 'lucide-react'
import { formatReset, remainingQuotaPercent, sessionStatus, sessionStatusLabels, type ItemView, type UserInput } from '@qn/codex-client'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { agentLabel, agentPlaceholder, sessionKey } from '../agents'
import { nearBottom } from '../composerLogic'
import { EMPTY_PREFS, resolveSelection } from '../models'
import { currentCwd, useApp } from '../store'
import { groupChatItems } from '../chatGroups'
import { formatTurnError } from '../state'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { ContextUsage } from './ContextUsage'
import { FileActionsContext, MessageItem, ToolGroup, type FileActions } from './MessageItem'
import { ModelPicker } from './ModelSheet'
import { NewSessionButton } from './NewSessionButton'
import { QueuedMessages } from './QueuedMessages'
import { RateLimitBadge, RateLimitDetails } from './RateLimitView'
import { SessionSwitcher } from './SessionSwitcher'
import { SubagentRpcContext } from './SubagentDetails'
import { Badge, Button, Dialog, Empty, Header, LoadingIcon, Note } from './ui'

const NO_ITEMS: ItemView[] = []

export function ChatPage() {
  const activeId = useApp((s) => s.activeId)
  const fingerprint = useApp((s) => s.connections.find((connection) => connection.id === s.activeId)?.fp)
  const projects = useApp((s) => s.projects)
  const selectedProjectId = useApp((s) => s.selectedProjectId)
  const selectedTargetId = useApp((s) => s.selectedTargetId)
  const selectedThreadId = useApp((s) => s.selectedThreadId)
  const selectedAgent = useApp((s) => s.selectedAgent)
  const openFile = useApp((s) => s.openFile)
  const openDiff = useApp((s) => s.openDiff)
  const key = selectedTargetId ? sessionKey(selectedTargetId, selectedAgent) : ''
  const session = useApp((s) => s.sessions[key])
  const models = useApp((s) => s.models[key]?.models)
  const modelPrefs = useApp((s) => s.modelPrefs[key] ?? EMPTY_PREFS)
  const threads = useApp((s) => s.threads)
  const sending = useApp((s) => s.sending)
  const error = useApp((s) => s.error)
  const notice = useApp((s) => s.notice)
  const annotations = useApp((s) => s.annotations)
  const draftText = useApp((s) => s.draftText)
  const setDraftText = useApp((s) => s.setDraftText)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const needsRepair = useApp((s) => (activeId ? s.needsRepair[activeId] : undefined))
  const beginRepair = useApp((s) => s.beginRepair)
  const goBack = useApp((s) => s.goBack)
  const send = useApp((s) => s.send)
  const interrupt = useApp((s) => s.interrupt)
  const respondApproval = useApp((s) => s.respondApproval)
  const approvalSubmitting = useApp((s) => s.approvalSubmitting)
  const addAnnotation = useApp((s) => s.addAnnotation)
  const updateAnnotation = useApp((s) => s.updateAnnotation)
  const removeAnnotation = useApp((s) => s.removeAnnotation)
  const ensureOpen = useApp((s) => s.ensureOpen)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const claudeLimit = useApp((s) => selectedTargetId ? s.claudeRateLimits[selectedTargetId] : undefined)
  const claudeCost = useApp((s) => s.claudeCosts[JSON.stringify([selectedTargetId, selectedThreadId])])
  const claudeUsed = claudeLimit?.primary?.usedPercent
  const claudeReached = claudeLimit?.rateLimitReachedType || claudeLimit?.spendControlReached === true
  const claudeQuota = claudeReached ? '已达额度上限'
    : claudeUsed != null ? `上报剩余 ${Math.round(remainingQuotaPercent(claudeUsed))}%` : null

  const chatKey = JSON.stringify([activeId, fingerprint, selectedTargetId, selectedAgent, selectedProjectId, selectedThreadId])
  const [quote, setQuote] = useState<{ key: string; text: string } | null>(null)
  const [showRate, setShowRate] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const approvalsRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const previousChat = useRef(chatKey)

  const view = selectedThreadId ? session?.state.threads[selectedThreadId] : undefined
  const items = view?.items ?? NO_ITEMS
  const approvals = view?.pendingApprovals ?? []
  const running = view?.status === 'running'
  const shownItems = useMemo(
    () => withoutErrorEcho(items, view?.error, running).filter((item) => item.kind !== 'reasoning'),
    [items, view?.error, running],
  )
  // index 记的是块里第一条在 shownItems 中的位置，用来判断是不是打开后新到的。
  const blocks = useMemo(() => {
    let index = 0
    return groupChatItems(shownItems).map((block) => {
      const entry = { block, index }
      index += block.kind === 'item' ? 1 : block.items.length
      return entry
    })
  }, [shownItems])
  // 打开会话时已有的历史直接显示，之后新到的消息才播放入场动画。
  const baseline = useRef({ key: '', count: 0 })
  if (baseline.current.key !== chatKey && shownItems.length > 0) baseline.current = { key: chatKey, count: shownItems.length }
  const project = projects.find((item) => item.id === selectedProjectId)
  // 冷启动恢复会话时列表可能还没加载，先用首条用户消息顶上，避免标题只剩项目名。
  const firstUser = items.find((item) => item.kind === 'user')
  const thread = threads.find((item) => item.id === selectedThreadId && item.agent === selectedAgent)
  const threadTitle = thread?.title
    || (firstUser?.kind === 'user' ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 60) : '')
  const statusLabel = selectedThreadId ? sessionStatusLabels[sessionStatus(view, thread?.activity)] : null
  const cwd = currentCwd({ projects, selectedProjectId })
  const imageUnavailable = selectedAgent === 'pi'
    ? '当前 Agent 暂不支持图片'
    : resolveSelection(models ?? [], modelPrefs).model?.imageInput === false ? '当前模型不支持图片' : undefined
  const fileActions = useMemo<FileActions>(() => ({
    cwd,
    openFile: (location) => void openFile(location),
    openDiff: (path, diff) => void openDiff({ path, diff: diff ?? null }),
  }), [cwd, openFile, openDiff])

  useLayoutEffect(() => {
    if (previousChat.current !== chatKey) {
      previousChat.current = chatKey
      following.current = true
      setAtBottom(true)
    }
    const node = scrollRef.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [chatKey, items, approvals.length])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      if (following.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  function updateScroll() {
    const node = scrollRef.current
    if (!node) return
    following.current = nearBottom(node)
    setAtBottom(following.current)
  }

  function jumpToLatest() {
    const node = scrollRef.current
    if (!node) return
    following.current = true
    setAtBottom(true)
    node.scrollTop = node.scrollHeight
  }

  async function resend(text: string, attachments: UserInput[]) {
    const sent = await send(text, attachments, false, 'queue', { keepDraft: true })
    if (sent) jumpToLatest()
    return sent
  }

  return (
    <>
      <Header
        title={threadTitle || project?.name || '对话'}
        subtitle={[statusLabel, project?.name, agentLabel(selectedAgent)].filter(Boolean).join(' · ')}
        onBack={goBack}
        right={
          <>
            {selectedAgent === 'codex' && <RateLimitBadge targetId={selectedTargetId} onToggle={() => setShowRate(true)} />}
            {selectedAgent === 'claude' && <Button variant="ghost" className="px-2 text-xs" onClick={() => setShowRate(true)}>{claudeQuota ?? '额度'}</Button>}
            {project && <NewSessionButton project={project} iconOnly className="qn-header-icon" />}
            <Button variant="ghost" className="qn-header-icon" onClick={() => setSwitching(true)} aria-label="切换会话">
              <PanelLeft size={20} strokeWidth={1.75} aria-hidden />
            </Button>
          </>
        }
      />
      {!eventsConnected && (
        <div className="border-b border-qn-border bg-qn-panel px-3 pt-2">
          <Note
            tone="warn"
            message={needsRepair ? '电脑连接需要重新配对' : '与电脑的连接中断，正在尝试恢复…'}
            actionLabel={needsRepair ? '重新配对' : undefined}
            onAction={needsRepair && activeId ? () => beginRepair(activeId) : undefined}
          />
        </div>
      )}
      {approvals.length > 0 && (
        <button className="qn-row border-b border-qn-border bg-qn-panel px-3 text-sm" type="button"
          onClick={() => approvalsRef.current?.scrollIntoView({ block: 'nearest' })}>
          <Badge tone="warn">{approvals.length} 项待审批</Badge>
          <span className="min-w-0 flex-1 truncate text-qn-muted">{approvals[0]?.title}</span><ChevronDown size={16} aria-hidden />
        </button>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="qn-body qn-scroll" onScroll={updateScroll}>
          {session?.openError && (
            <Note message={session.openError} tone="error" actionLabel="重试"
              onAction={() => { if (selectedTargetId) void ensureOpen(selectedTargetId, selectedAgent) }} />
          )}
          {items.length === 0 && approvals.length === 0 && <Empty>发送消息开始对话。</Empty>}
          <div className="space-y-4">
            <SubagentRpcContext.Provider key={chatKey} value={session?.rpc ?? null}>
              <FileActionsContext.Provider value={fileActions}>
                {blocks.map(({ block, index }) => (
                  <div key={block.kind === 'item' ? block.item.id : block.id}
                    className={baseline.current.key === chatKey && index >= baseline.current.count ? 'qn-message-enter' : undefined}>
                    {block.kind === 'item'
                      ? <MessageItem item={block.item} onQuote={(text) => setQuote({ key: chatKey, text })} agentName={agentLabel(selectedAgent)}
                        onResend={selectedThreadId ? resend : undefined} />
                      : <ToolGroup items={block.items} onQuote={(text) => setQuote({ key: chatKey, text })} />}
                  </div>
                ))}
              </FileActionsContext.Provider>
            </SubagentRpcContext.Provider>
            {/* 失败原因贴在最后一轮之后，和出错的位置对应；运行中且还没有回复时给出等待提示。 */}
            {running && shownItems.at(-1)?.kind === 'user' && (
              <div className="qn-thinking" role="status"><LoadingIcon />{agentLabel(selectedAgent)} 正在处理…</div>
            )}
            {!running && view?.error && <TurnErrorCard message={view.error} />}
            {approvals.length > 0 && (
              <div ref={approvalsRef} className="space-y-3">
                {approvals.map((approval) => (
                  <ApprovalCard key={String(approval.requestId)} approval={approval}
                    agent={selectedAgent} submitting={Boolean(approvalSubmitting[String(approval.requestId)])}
                    offline={!eventsConnected}
                    onDecide={(decision) => void respondApproval(approval.requestId, decision)} />
                ))}
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <Button className="absolute right-3 bottom-3 bg-qn-panel shadow-lg" onClick={jumpToLatest}>回到最新 <ArrowDown size={15} aria-hidden /></Button>
        )}
      </div>
      {(error || notice) && (
        <div className="bg-qn-panel px-3 pt-1">
          {error && <Note message={error} tone="error" onClose={clearError} />}
          {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
        </div>
      )}
      <QueuedMessages />
      <Composer
        key={chatKey}
        draftKey={chatKey}
        text={draftText}
        onChangeText={setDraftText}
        onSend={async (text, images, mode) => {
          const sent = await send(text, images, false, mode)
          if (sent) jumpToLatest()
          return sent
        }}
        onInterrupt={() => void interrupt()}
        running={running}
        sending={sending}
        disabled={!selectedTargetId}
        imageUnavailable={imageUnavailable}
        project={project}
        annotations={annotations}
        onUpdateAnnotation={updateAnnotation}
        onRemoveAnnotation={removeAnnotation}
        quoteDraft={quote?.key === chatKey ? quote.text : null}
        onConfirmQuote={(text, comment) => { addAnnotation(text, comment); setQuote(null) }}
        onCancelQuote={() => setQuote(null)}
        placeholder={agentPlaceholder(selectedAgent)}
        canSteer={selectedAgent === 'codex'}
        toolbar={
          <>
            {selectedAgent === 'pi' && <span className="text-[11px] text-qn-muted">工具直接执行</span>}
            {selectedTargetId && <ModelPicker targetId={selectedTargetId} agent={selectedAgent} />}
            <ContextUsage tokenUsage={view?.tokenUsage} />
          </>
        }
      />
      {switching && <SessionSwitcher onClose={() => setSwitching(false)} />}
      {showRate && (
        <Dialog title={`${agentLabel(selectedAgent)} 额度`} onClose={() => setShowRate(false)}>
          {selectedAgent === 'claude' ? (
            <div className="space-y-2 text-sm">
              <p>{claudeQuota ?? '暂无限额事件'}</p>
              {claudeLimit?.primary?.resetsAt != null && <p>{formatReset(claudeLimit.primary.resetsAt, Date.now())}</p>}
              {claudeCost != null && <p>本设备已收到的会话费用估算 {new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(claudeCost)}</p>}
              <p className="text-xs text-qn-muted">Claude 只在接近或触发限额时上报。</p>
            </div>
          ) : <RateLimitDetails targetId={selectedTargetId} />}
        </Dialog>
      )}
    </>
  )
}

/** Claude 会把失败原因同时作为一条普通回复发出；交给错误卡片统一显示，不重复两遍。 */
function withoutErrorEcho(items: readonly ItemView[], error: string | undefined, running: boolean): readonly ItemView[] {
  const last = items.at(-1)
  if (running || !error || last?.kind !== 'agent' || last.text.trim() !== error.trim()) return items
  return items.slice(0, -1)
}

function TurnErrorCard({ message }: { message: string }) {
  const { title, detail } = formatTurnError(message)
  return (
    <div className="qn-note qn-note-error qn-turn-error" role="alert">
      <div className="font-semibold">{title}</div>
      {detail && <div className="mt-1 text-xs whitespace-pre-wrap">{detail}</div>}
    </div>
  )
}
