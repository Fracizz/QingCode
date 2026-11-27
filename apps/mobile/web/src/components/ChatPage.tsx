import { ArrowDown, ChevronDown, PanelLeft, Square } from 'lucide-react'
import { sessionStatus, sessionStatusLabels, type ItemView, type UserInput } from '@qn/codex-client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { agentLabel, agentPlaceholder, sessionKey } from '../agents'
import { nearBottom } from '../composerLogic'
import { EMPTY_PREFS, resolveSelection } from '../models'
import { currentCwd, selectedCompactionBlockedReason, selectedCompactionStarting, useApp } from '../store'
import { groupChatItems, hiddenToolTrails, isChatVisible, replyPhase } from '../chatGroups'
import { formatTurnError, friendlyError } from '../state'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { ContextUsage } from './ContextUsage'
import { FileActionsContext, MessageItem, ToolGroup, type FileActions } from './MessageItem'
import { ModelPicker } from './ModelSheet'
import { NewSessionButton } from './NewSessionButton'
import { QueuedMessages } from './QueuedMessages'
import { SessionSwitcher } from './SessionSwitcher'
import { SubagentRpcContext } from './SubagentDetails'
import { Badge, Button, Empty, Header, Note } from './ui'

const NO_ITEMS: ItemView[] = []
const HISTORY_BATCH_SIZE = 60

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
  const compactConversation = useApp((s) => s.compactConversation)
  const compactionBlockedReason = useApp(selectedCompactionBlockedReason)
  const compactionStarting = useApp(selectedCompactionStarting)
  const respondApproval = useApp((s) => s.respondApproval)
  const approvalSubmitting = useApp((s) => s.approvalSubmitting)
  const addAnnotation = useApp((s) => s.addAnnotation)
  const updateAnnotation = useApp((s) => s.updateAnnotation)
  const removeAnnotation = useApp((s) => s.removeAnnotation)
  const ensureOpen = useApp((s) => s.ensureOpen)
  const clearError = useApp((s) => s.clearError)
  const clearNotice = useApp((s) => s.clearNotice)
  const claudeCost = useApp((s) => selectedAgent === 'claude'
    ? s.claudeCosts[JSON.stringify([selectedTargetId, selectedThreadId])] : undefined)

  const chatKey = JSON.stringify([activeId, fingerprint, selectedTargetId, selectedAgent, selectedProjectId, selectedThreadId])
  const [quote, setQuote] = useState<{ key: string; text: string } | null>(null)
  const [stopRequest, setStopRequest] = useState<{ chatKey: string; turnId: string; error: string | null } | null>(null)
  const [switching, setSwitching] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [historyStart, setHistoryStart] = useState<{ key: string; index: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyScroll = useRef<{ key: string; height: number; top: number } | null>(null)
  const approvalsRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const previousChat = useRef(chatKey)

  const view = selectedThreadId ? session?.state.threads[selectedThreadId] : undefined
  const items = view?.items ?? NO_ITEMS
  const approvals = view?.pendingApprovals ?? []
  const running = view?.status === 'running'
  const interrupted = !running && view?.activity === 'interrupted'
  const turnError = !running && !interrupted ? view?.error : undefined
  const currentStop = running && stopRequest?.chatKey === chatKey && stopRequest.turnId === view.activeTurnId ? stopRequest : null
  const stopping = currentStop !== null && currentStop.error === null
  const stopError = currentStop?.error
  const activeItemIds = running ? view.turns?.find((turn) => turn.id === view.activeTurnId)?.itemIds : undefined
  const progress = running && approvals.length === 0
    ? view.activity === 'input' ? '等待输入…'
      : view.activity === 'pending' ? '等待审批…'
        : `${agentLabel(selectedAgent)} ${replyPhase(items, activeItemIds)}…`
    : null
  const compacting = compactionStarting || items.some((item) => item.kind === 'other' &&
    item.type === 'contextCompaction' && item.status === 'inProgress' && activeItemIds?.includes(item.id))
  const echoFree = useMemo(() => withoutErrorEcho(items, view?.error, running), [items, view?.error, running])
  // 手机屏幕有限：推理摘要、命令和其它工具步骤都不进消息流，进度只在底部回复状态里体现。
  const shownItems = useMemo(() => echoFree.filter(isChatVisible), [echoFree])
  // 隐藏的命令每轮收成一行可展开的摘要，出错时还能查到跑了什么。
  const trails = useMemo(() => hiddenToolTrails(echoFree, activeItemIds), [echoFree, activeItemIds])
  // 每轮只有最后一条回复常驻操作入口：从后往前，遇到用户消息重置。
  const finalReplies = useMemo(() => {
    const ids = new Set<string>()
    let seen = false
    for (let index = shownItems.length - 1; index >= 0; index -= 1) {
      const item = shownItems[index]!
      if (item.kind === 'user') seen = false
      else if (item.kind === 'agent' && !seen) {
        ids.add(item.id)
        seen = true
      }
    }
    return ids
  }, [shownItems])
  // index 记的是块里第一条在 shownItems 中的位置，用来判断是不是打开后新到的。
  const blocks = useMemo(() => {
    let index = 0
    return groupChatItems(shownItems).map((block) => {
      const entry = { block, index }
      index += block.kind === 'item' ? 1 : block.items.length
      return entry
    })
  }, [shownItems])
  const trailOf = (block: (typeof blocks)[number]['block']) =>
    trails.get(block.kind === 'item' ? block.item.id : block.items.at(-1)!.id)
  const defaultStart = Math.max(0, blocks.length - HISTORY_BATCH_SIZE)
  const firstVisible = historyStart?.key === chatKey ? Math.min(historyStart.index, defaultStart) : defaultStart
  // 打开会话时已有的历史直接显示，之后新到的消息才播放入场动画。
  const baseline = useRef({ key: '', count: 0 })
  if (baseline.current.key !== chatKey && shownItems.length > 0) baseline.current = { key: chatKey, count: shownItems.length }
  const project = projects.find((item) => item.id === selectedProjectId)
  // 冷启动恢复会话时列表可能还没加载，先用首条用户消息顶上，避免标题只剩项目名。
  const firstUser = items.find((item) => item.kind === 'user')
  const thread = threads.find((item) => item.id === selectedThreadId && item.agent === selectedAgent)
  // 冷启动直接恢复到对话页时会话列表为空：补拉一次，让标题换成真正的会话名。
  const titleFetched = useRef('')
  useEffect(() => {
    if (!selectedThreadId || thread || !eventsConnected || titleFetched.current === chatKey) return
    titleFetched.current = chatKey
    void useApp.getState().refreshThreads({ skipFailed: true })
  }, [chatKey, eventsConnected, selectedThreadId, thread])
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
  }, [chatKey, items, approvals.length, progress, interrupted, turnError])

  useLayoutEffect(() => {
    const previous = historyScroll.current
    historyScroll.current = null
    const scroll = scrollRef.current
    if (scroll && previous?.key === chatKey) scroll.scrollTop = previous.top + scroll.scrollHeight - previous.height
  }, [chatKey, firstVisible])

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

  function showEarlier() {
    const node = scrollRef.current
    if (node) historyScroll.current = { key: chatKey, height: node.scrollHeight, top: node.scrollTop }
    following.current = false
    setAtBottom(false)
    setHistoryStart({ key: chatKey, index: Math.max(0, firstVisible - HISTORY_BATCH_SIZE) })
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

  async function stopTurn() {
    const turnId = view?.activeTurnId
    if (!running || !turnId || stopping) return
    const request = { chatKey, turnId, error: null }
    setStopRequest(request)
    try {
      await interrupt()
      setStopRequest((current) => current === request ? null : current)
    } catch (err) {
      const error = `未能中断本轮。${friendlyError(err, '请重试')}`
      setStopRequest((current) => current === request ? { ...request, error } : current)
    }
  }

  return (
    <>
      <Header
        title={threadTitle || project?.name || '对话'}
        subtitle={
          // 项目名可能很长：只让项目名截断，状态与 Agent 始终可见。
          <span className="flex min-w-0 items-center gap-1">
            {statusLabel && <span className="shrink-0">{statusLabel} ·</span>}
            {project?.name && <span className="min-w-0 truncate">{project.name}</span>}
            <span className="shrink-0">{project?.name ? '· ' : ''}{agentLabel(selectedAgent)}</span>
          </span>
        }
        onBack={goBack}
        right={
          <>
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
          {!running && items.length === 0 && approvals.length === 0 && <Empty>发送消息开始对话。</Empty>}
          <div className="space-y-4">
            {firstVisible > 0 && (
              <Button variant="ghost" className="mx-auto flex" onClick={showEarlier}>查看更早消息</Button>
            )}
            <SubagentRpcContext.Provider key={chatKey} value={session?.rpc ?? null}>
              <FileActionsContext.Provider value={fileActions}>
                {blocks.slice(firstVisible).map(({ block, index }) => (
                  <div key={block.kind === 'item' ? block.item.id : block.id}
                    className={baseline.current.key === chatKey && index >= baseline.current.count ? 'qn-message-enter' : undefined}>
                    {block.kind === 'item'
                      ? <MessageItem item={block.item} onQuote={(text) => setQuote({ key: chatKey, text })} agentName={agentLabel(selectedAgent)}
                        active={activeItemIds?.includes(block.item.id)} showActions={finalReplies.has(block.item.id)}
                        onResend={selectedThreadId ? resend : undefined} />
                      : <ToolGroup items={block.items} onQuote={(text) => setQuote({ key: chatKey, text })} />}
                    {trailOf(block) && <ToolGroup trail items={trailOf(block)!} onQuote={(text) => setQuote({ key: chatKey, text })} />}
                  </div>
                ))}
              </FileActionsContext.Provider>
            </SubagentRpcContext.Provider>
            {progress && (
              <div className="qn-thinking qn-replying" role="status">
                <span className="qn-typing-dots" aria-hidden><i /><i /><i /></span>{progress}
              </div>
            )}
            {interrupted && <div className="qn-turn-interrupted" role="status"><Square size={13} aria-hidden />本轮已中断</div>}
            {turnError && <TurnErrorCard message={turnError} />}
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
          <button type="button" className="qn-jump-latest" onClick={jumpToLatest} aria-label="回到最新">
            <ArrowDown size={18} aria-hidden />{running && <span className="qn-jump-live" aria-hidden />}
          </button>
        )}
      </div>
      {(error || notice || stopError) && (
        <div className="bg-qn-panel px-3 pt-1">
          {error && <Note message={error} tone="error" onClose={clearError} />}
          {notice && <Note message={notice} tone="warn" onClose={clearNotice} />}
          {stopError && <div role="alert"><Note message={stopError} tone="error" onClose={() => setStopRequest(null)} /></div>}
        </div>
      )}
      <QueuedMessages key={`queue:${chatKey}`} running={running} canSteer={selectedAgent === 'codex' && !!view?.activeTurnId} />
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
        onInterrupt={() => void stopTurn()}
        interrupting={stopping}
        running={running}
        sending={sending}
        compacting={compacting}
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
        canSteer={selectedAgent === 'codex' && !!view?.activeTurnId}
        toolbar={
          <>
            {selectedAgent === 'pi' && <span className="text-[11px] text-qn-muted">工具直接执行</span>}
            {selectedTargetId && <ModelPicker targetId={selectedTargetId} agent={selectedAgent} />}
            <ContextUsage tokenUsage={view?.tokenUsage} estimatedCostUsd={claudeCost} compact={selectedAgent === 'codex' && selectedThreadId ? {
              busy: compacting,
              blockedReason: compactionBlockedReason,
              onConfirm: () => void compactConversation(),
            } : undefined} />
          </>
        }
      />
      {switching && <SessionSwitcher onClose={() => setSwitching(false)} />}
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

