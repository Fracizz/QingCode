import { ArrowDown, Bot, ChevronDown, ListChecks, MessageCirclePlus } from 'lucide-react'
import { AGENT_CAPABILITIES, branchPoint, canReviseMessage, chatCommands, chatCommandUnavailable, collectSubagents, includeWorkSummary, interruptTurnIdOf, mergeSlashCommands, planApproval, resolveAccessMode, sessionAccessOptions, sessionStatus, sessionStatusLabels, revisionNote, turnOpeningMessages, turnSteerBlock, type ChatCommandId, type ItemView, type UserInput, t, translateMessage } from '@qn/codex-client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { agentLabel, agentPlaceholder, sessionKey } from '../agents'
import { bindChatPinch } from '../chatFont'
import { toast } from '../toast'
import { copyText } from '../client'
import { nearBottom } from '../composerLogic'
import { prefsFor, resolveSelection } from '../models'
import { currentCwd, displayedAccessMode, selectedAccessMode, selectedPendingSteers, selectedAccessPreference, selectedCompactionBlockedReason, selectedCompactionStarting, selectedPlanReturn, selectedQueuedSends, useApp } from '../store'
import { chatTimeline, replyPhase, streamingReplyId } from '../chatGroups'
import { formatTurnError, friendlyError } from '../state'
import { changeThreadPreference, threadPreferenceKey, useWorkspacePreferences } from '../workspace'
import { ApprovalCard } from './ApprovalCard'
import { UserInputCard } from './UserInputCard'
import { AccessModePicker, NoApprovalNotice } from './AccessModePicker'
import { Composer } from './Composer'
import { ContextUsage } from './ContextUsage'
import { FileActionsContext, MessageItem, ToolGroup, WorkGroup, type FileActions } from './MessageItem'
import { ModelPicker } from './ModelSheet'
import { NewSessionButton } from './NewSessionButton'
import { ProjectTools } from './ProjectTools'
import { PendingSteers } from './PendingSteers'
import { QueuedMessages } from './QueuedMessages'
import { AgentQuota } from './RateLimitView'
import { SessionSwitcher } from './SessionSwitcher'
import { skillsKey, useSkills } from '../skills'
import { slashCommandsKey, useSlashCommands } from '../slashCommands'
import { planLabel, StatusDock, type DockSheet } from './StatusDock'
import { Badge, Button, Dialog, Empty, Header, LoadingIcon, Note } from './ui'

const NO_ITEMS: ItemView[] = []
// 手机版不提供 Git 差异，/diff 不出现在命令列表里，输入后按普通文本发送。
const MOBILE_HIDDEN_COMMANDS: readonly ChatCommandId[] = ['diff']
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
  // accessMode 是本轮实际生效的档位；选择器显示已选档位（运行中修改时下一轮才生效）。
  const accessMode = useApp(displayedAccessMode)
  const nextAccessMode = useApp(selectedAccessMode)
  const accessSelection = useApp(selectedAccessPreference) ?? 'inherit'
  const inheritedAccessMode = useApp((s) => s.agentSettings || s.legacyAgentSettings
    ? resolveAccessMode(s.selectedAgent, s.agentSettings?.globalAccessMode) : undefined)
  const setAccessMode = useApp((s) => s.setAccessMode)
  const planReturn = useApp(selectedPlanReturn)
  const models =useApp((s) => s.models[key]?.models)
  const prefsTable = useApp((s) => s.modelPrefs)
  const savedConfig = useApp((s) => selectedThreadId ? s.sessions[key]?.state.threads[selectedThreadId]?.savedConfig : undefined)
  const modelPrefs = useMemo(() => prefsFor(prefsTable, selectedAgent, key, selectedThreadId, models, savedConfig),
    [prefsTable, selectedAgent, key, selectedThreadId, models, savedConfig])
  const threads = useApp((s) => s.threads)
  const preferences = useWorkspacePreferences()
  const sending = useApp((s) => s.sending)
  const annotations = useApp((s) => s.annotations)
  const draftText = useApp((s) => s.draftText)
  const setDraftText = useApp((s) => s.setDraftText)
  const eventsConnected = useApp((s) => s.eventsConnected)
  const needsRepair = useApp((s) => (activeId ? s.needsRepair[activeId] : undefined))
  const beginRepair = useApp((s) => s.beginRepair)
  const send = useApp((s) => s.send)
  const sendRevision = useApp((s) => s.sendRevision)
  const interrupt = useApp((s) => s.interrupt)
  const compactConversation = useApp((s) => s.compactConversation)
  const compactionBlockedReason = useApp(selectedCompactionBlockedReason)
  const compactionStarting = useApp(selectedCompactionStarting)
  const queuedCount = useApp((s) => selectedQueuedSends(s)?.length ?? 0)
  const respondApproval = useApp((s) => s.respondApproval)
  const respondUserInput = useApp((s) => s.respondUserInput)
  const approvalSubmitting = useApp((s) => s.approvalSubmitting)
  const addAnnotation = useApp((s) => s.addAnnotation)
  const updateAnnotation = useApp((s) => s.updateAnnotation)
  const removeAnnotation = useApp((s) => s.removeAnnotation)
  const ensureOpen = useApp((s) => s.ensureOpen)

  const chatKey = JSON.stringify([activeId, fingerprint, selectedTargetId, selectedAgent, selectedProjectId, selectedThreadId])
  const [quote, setQuote] = useState<{ key: string; text: string } | null>(null)
  const [stopRequest, setStopRequest] = useState<{ chatKey: string; turnId: string } | null>(null)
  const [switching, setSwitching] = useState(false)
  const [dockSheet, setDockSheet] = useState<{ key: string; sheet: DockSheet } | null>(null)
  const [commandDialog, setCommandDialog] = useState<{ key: string; id: ChatCommandId } | null>(null)
  const [contextPanel, setContextPanel] = useState<{ key: string; panel: 'usage' } | null>(null)
  const [commandFeedback, setCommandFeedback] = useState<{ key: string; message: string } | null>(null)
  const [commandName, setCommandName] = useState('')
  const [commandPending, setCommandPending] = useState(false)
  const activeCommand = commandDialog?.key === chatKey ? commandDialog.id : null
  const commandMessage = commandFeedback?.key === chatKey ? commandFeedback.message : null
  const [historyStart, setHistoryStart] = useState<{ key: string; index: number } | null>(null)
  const [historyLoad, setHistoryLoad] = useState<{ key: string; error?: string } | null>(null)
  const loadEarlierHistory = useApp((s) => s.loadEarlierHistory)
  const chatSurface = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ key: string; text: string } | null>(null)
  useLayoutEffect(() => {
    const root = chatSurface.current
    // 缩放中同一条提示原地刷新字号，松手后自动消失。
    if (root) return bindChatPinch(root, (size) => {
      if (size !== null) toast(t('对话字号 {size}px', { size }), { key: 'chat-font', duration: 1500 })
    })
  }, [])
  useLayoutEffect(() => {
    const capture = () => {
      const range = window.getSelection()
      const transcript = scrollRef.current
      const text = range && transcript?.contains(range.anchorNode) && transcript.contains(range.focusNode)
        ? range.toString().trim().slice(0, 4000) : ''
      setSelection(text ? { key: chatKey, text } : null)
    }
    document.addEventListener('selectionchange', capture)
    return () => document.removeEventListener('selectionchange', capture)
  }, [chatKey])
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyScroll = useRef<{ key: string; height: number; top: number } | null>(null)
  const approvalsRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const contentRef = useRef<HTMLDivElement>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const pendingSteerCount = useApp((s) => selectedPendingSteers(s)?.length ?? 0)
  const previousChat = useRef(chatKey)

  const view = selectedThreadId ? session?.state.threads[selectedThreadId] : undefined
  const items = view?.items ?? NO_ITEMS
  const subagents = useMemo(() => collectSubagents(items, selectedThreadId ?? undefined, session?.state.threads),
    [items, selectedThreadId, session?.state.threads])
  const approvals = view?.pendingApprovals ?? []
  const running = view?.status === 'running'
  const streamingId = streamingReplyId(view)
  const interrupted = !running && view?.activity === 'interrupted'
  const turnError = !running && !interrupted ? view?.error : undefined
  const currentStop = running && stopRequest?.chatKey === chatKey && stopRequest.turnId === interruptTurnIdOf(view) ? stopRequest : null
  const stopping = currentStop !== null
  // 中断失败回来时本轮可能已结束或已切走，只对仍在运行的同一轮提示失败。
  const liveTurn = useRef<string | null>(null)
  liveTurn.current = running ? JSON.stringify([chatKey, interruptTurnIdOf(view)]) : null
  const activeItemIds = running ? view.turns?.find((turn) => turn.id === view.activeTurnId)?.itemIds : undefined
  const progress = running && approvals.length === 0
    ? view.activity === 'input' ? t('等待输入…')
      : view.activity === 'pending' ? t('等待审批…')
        : t('{agent} {phase}…', { agent: agentLabel(selectedAgent), phase: replyPhase(items, activeItemIds) })
    : null
  const compacting = compactionStarting || items.some((item) => item.kind === 'other' &&
    item.type === 'contextCompaction' && item.status === 'inProgress' && activeItemIds?.includes(item.id))
  const canSteer = running && turnSteerBlock(selectedAgent, view, compactionStarting) === null
  const compactionWillQueue = running || sending || approvals.length > 0 || queuedCount > 0
  const timeline = useMemo(() => chatTimeline(withoutErrorEcho(items, view?.error, running), view?.turns, running, activeItemIds),
    [items, view?.error, view?.turns, running, activeItemIds])
  const latestStop = interrupted && view?.turns?.at(-1)?.outcome === 'interrupted' ? view.turns.at(-1)?.id : undefined
  const latestStopKey = latestStop ? `stopped-${latestStop}` : undefined
  const defaultStart = Math.max(0, timeline.length - HISTORY_BATCH_SIZE)
  const firstVisible = includeWorkSummary(timeline, historyStart?.key === chatKey ? Math.min(historyStart.index, defaultStart) : defaultStart)
  const historyLoading = historyLoad?.key === chatKey && historyLoad.error === undefined
  const historyError = historyLoad?.key === chatKey ? historyLoad.error : undefined
  // 打开会话时已有的历史直接显示，之后新到的消息才播放入场动画。
  const baseline = useRef({ key: '', count: 0, firstId: '' })
  const firstId = timeline[0]?.key
  if (firstId && baseline.current.key !== chatKey) {
    baseline.current = { key: chatKey, count: timeline.length, firstId }
  } else if (firstId && baseline.current.firstId !== firstId) {
    const inserted = timeline.findIndex((entry) => entry.key === baseline.current.firstId)
    baseline.current = { key: chatKey, count: inserted < 0 ? timeline.length : baseline.current.count + inserted, firstId }
  }
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
  const threadTitle = (selectedTargetId && selectedThreadId
    ? preferences?.threads[threadPreferenceKey(selectedTargetId, selectedAgent, selectedThreadId)]?.title : undefined) || thread?.title
    || (firstUser?.kind === 'user' ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 60) : '')
  const subtitleProject = threadTitle ? project?.name : undefined
  const statusLabel = selectedThreadId ? sessionStatusLabels[sessionStatus(view, thread?.activity)] : null
  const cwd = currentCwd({ projects, selectedProjectId })
  // 技能随 Agent、目标和项目变化；会话连上后再拉，Claude 空闲时强制刷新以带出刚装的技能。
  const skillKey = selectedTargetId ? skillsKey(selectedTargetId, selectedAgent, cwd || null) : null
  const skills = useSkills((s) => skillKey ? s.lists[skillKey]?.items : undefined)
  const loadSkills = useSkills((s) => s.load)
  const skillRpc = session?.opened ? session.rpc : undefined
  // pi 的技能要借运行中的会话进程读取，会话载入后再取一次。
  const loadedThreadId = view ? selectedThreadId : null
  useEffect(() => {
    if (skillKey && skillRpc) void loadSkills(skillKey, cwd || null, skillRpc, selectedAgent !== 'codex' && !running)
  }, [skillKey, cwd, skillRpc, loadSkills, selectedAgent, running, loadedThreadId])
  // Agent 原生斜杠命令由运行中的会话进程提供：会话载入、轮次结束、重连和打开菜单时刷新。
  const commandKey = selectedThreadId && AGENT_CAPABILITIES[selectedAgent].commandList
    ? slashCommandsKey(key, selectedThreadId) : null
  const nativeList = useSlashCommands((s) => commandKey ? s.lists[commandKey] : undefined)
  const nativeCommands = useMemo(() => mergeSlashCommands(nativeList ?? [], skills?.map((skill) => skill.name)),
    [nativeList, skills])
  const refreshCommands = () => {
    if (commandKey && selectedThreadId && skillRpc && eventsConnected) {
      void useSlashCommands.getState().load(commandKey, selectedThreadId, skillRpc)
    }
  }
  useEffect(refreshCommands, [commandKey, skillRpc, running, loadedThreadId, eventsConnected])
  const imageUnavailable = resolveSelection(models ?? [], modelPrefs).model?.imageInput === false
    ? t('当前模型不支持图片') : undefined
  const fileActions = useMemo<FileActions>(() => ({
    cwd,
    openFile: (location) => void openFile(location),
    openDiff: (path, diff) => void openDiff({ path, diff: diff ?? null }),
  }), [cwd, openFile, openDiff])

  useLayoutEffect(() => {
    if (previousChat.current !== chatKey) {
      setAwayFromBottom(false)
      previousChat.current = chatKey
      following.current = true
    }
    const node = scrollRef.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [chatKey, timeline, approvals.length, progress, interrupted, turnError, pendingSteerCount])

  useLayoutEffect(() => {
    const previous = historyScroll.current
    historyScroll.current = null
    const scroll = scrollRef.current
    if (scroll && previous?.key === chatKey) scroll.scrollTop = previous.top + scroll.scrollHeight - previous.height
  }, [chatKey, firstVisible, view?.historyCursor])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      if (following.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    // 内容自己变高（引导说明出现、卡片展开、图片加载）时也贴底，不只在条目变化时。
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  // 新发出的引导排在对话末尾：发出时直接滚到最新，确保能看到它和等待说明。
  const steerCount = useRef(pendingSteerCount)
  useEffect(() => {
    const grew = pendingSteerCount > steerCount.current
    steerCount.current = pendingSteerCount
    if (grew) jumpToLatest()
  })

  function updateScroll() {
    const node = scrollRef.current
    if (!node) return
    following.current = nearBottom(node)
    // 离底部超过约半屏才显示回到底部，贴底附近的小幅滚动不闪按钮。
    const away = node.scrollHeight - node.scrollTop - node.clientHeight > node.clientHeight / 2
    setAwayFromBottom((current) => current === away ? current : away)
  }

  async function showEarlier() {
    if (historyLoading) return
    const reveal = () => {
      const node = scrollRef.current
      if (node) historyScroll.current = { key: chatKey, height: node.scrollHeight, top: node.scrollTop }
      following.current = false
      setHistoryStart({ key: chatKey, index: Math.max(0, firstVisible - HISTORY_BATCH_SIZE) })
    }
    if (firstVisible > 0) {
      reveal()
      return
    }
    const load = { key: chatKey }
    setHistoryLoad(load)
    try {
      await loadEarlierHistory(reveal)
      setHistoryLoad((current) => current === load ? null : current)
    } catch (error) {
      setHistoryLoad((current) => current === load ? { ...load, error: friendlyError(error, t('加载历史失败')) } : current)
    }
  }

  function jumpToLatest() {
    const node = scrollRef.current
    if (!node) return
    following.current = true
    node.scrollTop = node.scrollHeight
    setAwayFromBottom(false)
  }

  // 编辑并重发与电脑版同一套规则：能回退的原地改写，只能分支的从上一轮分出新会话；运行中不能改。
  const revisionCaps = AGENT_CAPABILITIES[selectedAgent]
  const turnOpeners = useMemo(() => turnOpeningMessages(view), [view?.items, view?.turns])
  // 整个会话的第一条消息分支重发时开新会话，说明文字不同。
  const startingMessage = useMemo(() => {
    const first = turnOpeners.keys().next().value
    return first && branchPoint(view, first)?.kind === 'start' ? first : null
  }, [turnOpeners, view?.historyCursor])
  const revisionFor = (itemId: string) => {
    if (!selectedThreadId || !canReviseMessage(revisionCaps, running, itemId, turnOpeners)) return {}
    return {
      onResend: async (text: string, attachments: UserInput[]) => {
        const sent = await sendRevision(itemId, text, attachments)
        if (sent) jumpToLatest()
        return sent
      },
      resendNote: revisionNote(revisionCaps, itemId === startingMessage),
    }
  }

  async function stopTurn() {
    const turnId = interruptTurnIdOf(view)
    if (!running || turnId === null || stopping) return
    const request = { chatKey, turnId }
    setStopRequest(request)
    try {
      await interrupt()
      setStopRequest((current) => current === request ? null : current)
    } catch (err) {
      setStopRequest((current) => current === request ? null : current)
      if (liveTurn.current === JSON.stringify([chatKey, turnId])) toast(t('未能中断本轮。{message}', { message: translateMessage(friendlyError(err, t('请重试'))) }), { tone: 'error' })
    }
  }

  const changeDockSheet = useCallback((sheet: DockSheet | null) => setDockSheet(sheet ? { key: chatKey, sheet } : null), [chatKey])
  // 状态胶囊收回后，历史子代理与任务清单仍可从顶栏“⋯”菜单查看。
  const dockActions = [
    ...(subagents.length ? [{ icon: Bot, label: `${t('子代理')} · ${subagents.length}`, onClick: () => changeDockSheet('subagents') }] : []),
    ...(view?.plan?.steps.length ? [{ icon: ListChecks, label: planLabel(view.plan), onClick: () => changeDockSheet('plan') }] : []),
  ]
  const latestReply = items.findLast((item) => item.kind === 'agent' && !item.streaming && item.text.trim())
  const commandReason = (id: ChatCommandId) => {
    if (id === 'model' && !session?.opened) return t('请先连接当前 Agent')
    return chatCommandUnavailable(id, {
      agent: selectedAgent, thread: !!selectedThreadId, running, busy: sending || compacting || commandPending,
      compactBlocked: compactionBlockedReason, hasReply: !!latestReply,
    })
  }
  const closeCommand = () => setCommandDialog(null)
  // 弹窗外的命令反馈走悬浮提示；弹窗内的失败原因留在弹窗里。
  const showCommandMessage = (message: string) => toast(message)

  function runCommand(id: ChatCommandId) {
    const blocked = commandReason(id)
    if (blocked) { showCommandMessage(blocked); return }
    setCommandFeedback(null)
    const state = useApp.getState()
    switch (id) {
      case 'new': void state.newThread(selectedAgent); return
      case 'resume': setSwitching(true); return
      case 'stop': void stopTurn(); return
      case 'refresh':
        void state.refreshThreads()
        if (skillKey && skillRpc) void loadSkills(skillKey, cwd || null, skillRpc, true)
        return
      // 压缩不再二次确认：命令和用量面板里的按钮都直接开始。
      case 'compact': void compactConversation(); return
      case 'context': setContextPanel({ key: chatKey, panel: 'usage' }); return
      case 'model':
        if (selectedTargetId) void state.loadModels(selectedTargetId, selectedAgent, true)
        break
      case 'rename': setCommandName(threadTitle); break
      case 'copy':
        if (latestReply?.kind === 'agent') {
          void copyText(latestReply.text).then(() => showCommandMessage(t('已复制最近一条回复')), () => showCommandMessage(t('复制失败')))
        }
        return
    }
    setCommandDialog({ key: chatKey, id })
  }

  function forkAction(itemId: string) {
    const turn = view?.turns?.find((candidate) => candidate.itemIds.includes(itemId))
    // 进行中的一轮还没有完整回复，不能作为分叉点。
    if (!selectedThreadId || !turn || turn.id === view?.activeTurnId) return undefined
    return () => void forkFromTurn(turn.id)
  }

  async function forkFromTurn(turnId: string) {
    if (commandPending) return
    setCommandPending(true)
    try {
      if (await useApp.getState().forkConversation(turnId)) toast(t('已创建聊天分支'))
    } catch (error) {
      toast(translateMessage(friendlyError(error, t('创建分支失败'))), { tone: 'error' })
    } finally {
      setCommandPending(false)
    }
  }

  async function confirmCommand(id: 'rename' | 'archive' | 'fork') {
    if (!selectedTargetId || !selectedThreadId || commandReason(id)) return
    const name = commandName.trim()
    if (id === 'rename' && !name) return
    const state = useApp.getState()
    const address = { id: selectedThreadId, agent: selectedAgent, targetId: selectedTargetId }
    setCommandPending(true)
    try {
      if (id === 'archive') await state.archiveConversation(selectedTargetId, address)
      else if (id === 'fork') await state.forkConversation()
      else {
        const saved = await state.renameConversation(selectedTargetId, selectedThreadId, name, selectedAgent)
        if (activeId) changeThreadPreference(activeId, address, { title: saved === 'local' ? name : undefined })
      }
      setCommandDialog((current) => current?.key === chatKey && current.id === id ? null : current)
    } catch (error) {
      setCommandFeedback({ key: chatKey, message: friendlyError(error, t('会话操作失败')) })
    } finally {
      setCommandPending(false)
    }
  }

  return (
    <>
      <Header
        className="qn-chat-header"
        title={threadTitle || project?.name || t('对话')}
        icon={
          <Button variant="ghost" className="qn-header-icon qn-header-island size-[44px] shrink-0" onClick={() => setSwitching(true)}
            aria-label={t('切换会话')} aria-haspopup="dialog" aria-expanded={switching}>
            <MenuLinesIcon />
          </Button>
        }
        subtitle={
          // 项目名可能很长：只让项目名截断，状态与 Agent 始终可见。
          <span className="flex min-w-0 items-center gap-1">
            {statusLabel && <span className="shrink-0">{statusLabel} ·</span>}
            {subtitleProject && <span className="min-w-0 truncate">{subtitleProject}</span>}
            <span className="shrink-0">{subtitleProject ? '· ' : ''}{agentLabel(selectedAgent)}</span>
          </span>
        }
        right={
          // 右侧操作收进一个悬浮按钮组，与左侧会话切换按钮呼应，标题区不再被分隔线截断。
          <div className="qn-header-island">
            {/* 常驻新建入口：不必先回到会话列表；无当前项目时由按钮内弹出项目选择。 */}
            <NewSessionButton project={project} projects={projects} iconOnly icon={MessageCirclePlus} className="qn-header-icon h-[44px] w-[50px] shrink-0" />
            {/* 对话中直接进入项目文件、终端等页面，不必先退回项目列表。 */}
            {project && <ProjectTools key={project.id} project={project} compact className="qn-header-icon h-[44px] w-[50px] shrink-0"
              actions={dockActions} />}
          </div>
        }
      />
      {needsRepair && activeId && (
        <div className="border-b border-qn-divider bg-qn-panel px-3 pt-2">
          <Note
            tone="warn"
            message={t('电脑连接需要重新配对')}
            actionLabel={t('重新配对')}
            onAction={() => beginRepair(activeId)}
          />
        </div>
      )}
      {approvals.length > 0 && (
        <button className="qn-row border-b border-qn-divider bg-qn-panel px-3 text-sm" type="button"
          onClick={() => approvalsRef.current?.scrollIntoView({ block: 'nearest' })}>
          <Badge tone="warn">{approvals.every((item) => item.questions?.length)
            ? approvals.length === 1 ? t('1 项待回答') : t('{count} 项待回答', { count: approvals.length })
            : approvals.length === 1 ? t('1 项待审批') : t('{count} 项待审批', { count: approvals.length })}</Badge>
          <span className="min-w-0 flex-1 truncate text-qn-muted">{translateMessage(approvals[0]?.title ?? '')}</span><ChevronDown size={16} aria-hidden />
        </button>
      )}
      <div ref={chatSurface} className="qn-chat-surface">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="qn-body qn-scroll" onScroll={updateScroll}>
            {session?.openError && (
              <Note message={session.openError} tone="error" actionLabel={t('重试')}
                onAction={() => { if (selectedTargetId) void ensureOpen(selectedTargetId, selectedAgent) }} />
            )}
            {!running && items.length === 0 && approvals.length === 0 && !view?.historyCursor && !timeline.length && !interrupted && <Empty>{t('发送消息开始对话。')}</Empty>}
            <div ref={contentRef} className="space-y-4">
              {(firstVisible > 0 || view?.historyCursor) && (
                <Button variant="ghost" className="mx-auto flex" disabled={historyLoading} onClick={() => void showEarlier()}>
                  {historyLoading ? t('正在加载更早消息…') : t('查看更早消息')}
                </Button>
              )}
              {historyError && <Note message={historyError} tone="error" />}
              <FileActionsContext.Provider key={chatKey} value={fileActions}>
                {timeline.slice(firstVisible).map((entry, offset) => {
                  const index = firstVisible + offset
                  const onQuote = (text: string) => setQuote({ key: chatKey, text })
                  if (entry.kind === 'work') return <WorkGroup key={entry.key} work={entry} onQuote={onQuote} />
                  if (entry.kind === 'stopped') return <TurnInterrupted key={entry.key}
                    announce={entry.key === latestStopKey || (interrupted && index === timeline.length - 1)} />
                  const { block, trail, finalReply } = entry
                  const previous = offset > 0 ? timeline[index - 1] : undefined
                  return (
                    <div key={entry.key}
                      className={baseline.current.key === chatKey && index >= baseline.current.count ? 'qn-message-enter' : undefined}>
                      {block.kind === 'item'
                        ? <MessageItem item={block.item} onQuote={onQuote} agentName={agentLabel(selectedAgent)}
                          active={activeItemIds?.includes(block.item.id)}
                          showStreamingDots={block.item.id === streamingId}
                          showActions={finalReply}
                          replyTimeInSummary={previous?.kind === 'work' && previous.reply?.id === block.item.id}
                          {...(block.item.kind === 'user' ? revisionFor(block.item.id) : {})}
                          onFork={forkAction(block.item.id)} />
                        : <ToolGroup items={block.items} onQuote={onQuote} />}
                      {trail && <ToolGroup trail items={trail} onQuote={onQuote} />}
                    </div>
                  )
                })}
              </FileActionsContext.Provider>
                <PendingSteers key={`steer:${chatKey}`} items={items} running={running} agentName={agentLabel(selectedAgent)}
                  onRestore={(text) => {
                    // 输入框已有内容时追加在后面，不覆盖用户正在写的草稿。
                    const current = useApp.getState().draftText
                    setDraftText(current.trim() ? `${current}
${text}` : text)
                  }} />
              {progress && (
                <div className="qn-thinking qn-replying" role="status"><LoadingIcon aria-hidden />{progress}</div>
              )}
              {/* 刚停掉的一轮没留下任何内容时补一条提示；末尾已经是停止提示就不再重复。 */}
              {interrupted && timeline.at(-1)?.kind !== 'stopped'
                && !timeline.some((entry) => entry.kind === 'stopped' && entry.key === latestStopKey) && <TurnInterrupted announce />}
              {turnError && <TurnErrorCard message={turnError} />}
              {approvals.length > 0 && (
                <div ref={approvalsRef} className="space-y-3">
                  {approvals.map((approval) => approval.questions?.length ? (
                    <UserInputCard key={String(approval.requestId)} approval={approval}
                      submitting={Boolean(approvalSubmitting[String(approval.requestId)])}
                      offline={!eventsConnected}
                      onSubmit={(answers) => void respondUserInput(approval.requestId, answers)} />
                  ) : (
                    <ApprovalCard key={String(approval.requestId)} approval={approval}
                      agent={selectedAgent} plan={planApproval(view, approval)?.plan}
                      submitting={Boolean(approvalSubmitting[String(approval.requestId)])}
                      offline={!eventsConnected}
                      onDecide={(decision) => void respondApproval(approval.requestId, decision)} />
                  ))}
                </div>
              )}
            </div>
          </div>
          {selection?.key === chatKey && (
            <Button className="absolute bottom-3 left-4 bg-qn-composer shadow-(--qn-float-shadow)"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuote(selection); window.getSelection()?.removeAllRanges(); setSelection(null) }}>
              {t('引用选中文字')}
            </Button>
          )}
          {/* 子代理、任务清单、后台任务：需要关注时从右上角滑出。 */}
          <FileActionsContext.Provider value={fileActions}>
            <StatusDock key={`dock:${chatKey}`} sheet={dockSheet?.key === chatKey ? dockSheet.sheet : null} onSheetChange={changeDockSheet}
              scrollRef={scrollRef} plan={view?.plan} running={running} subagents={subagents} threads={session?.state.threads}
              rpc={eventsConnected && session?.opened ? session.rpc : null}
              renderItem={(item, showStreamingDots) => <MessageItem key={item.id} item={item} showStreamingDots={showStreamingDots} />} />
          </FileActionsContext.Provider>
          {/* 往上翻看历史时给一个回到最新的入口，靠右下、贴近拇指；流式输出不再抢滚动。 */}
          {awayFromBottom && (
            <Button variant="ghost" className="qn-jump-latest" aria-label={t('回到最新消息')} onClick={jumpToLatest}>
              <ArrowDown size={18} strokeWidth={1.9} aria-hidden />
            </Button>
          )}
        </div>
        <QueuedMessages key={`queue:${chatKey}`} running={running} canSteer={canSteer} />
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
          agent={selectedAgent}
          canSteer={canSteer}
          steerHint={selectedAgent === 'claude' ? t('本轮结束时可能进入下一轮') : undefined}
          commands={{ run: runCommand, unavailable: commandReason, hidden: MOBILE_HIDDEN_COMMANDS }}
          skills={skills}
          nativeCommands={nativeCommands}
          onCommandMenuOpen={refreshCommands}
          planMode={selectedThreadId && nextAccessMode === 'plan' ? {
            disabled: !eventsConnected || !session?.opened || sending || compacting,
            onExit: () => setAccessMode(planReturn),
          } : undefined}
          toolbar={
            <>
              {selectedAgent === 'pi' && <NoApprovalNotice />}
              {selectedTargetId && selectedThreadId && selectedAgent !== 'pi' && (
                <AccessModePicker key={chatKey} agent={selectedAgent} mode={accessSelection} effectiveMode={nextAccessMode}
                  inheritedMode={inheritedAccessMode}
                  supported={session?.accessSupported === true}
                  // 运行中也可修改：手机网关在每轮发送时读取访问模式，当前这一轮不受影响。
                  disabled={!eventsConnected || !session?.opened || sending || compacting}
                  deferred={running}
                  onChange={setAccessMode} />
              )}
              {selectedTargetId && <ModelPicker targetId={selectedTargetId} agent={selectedAgent}
                open={activeCommand === 'model'} onOpenChange={(open) => setCommandDialog(open ? { key: chatKey, id: 'model' } : null)} />}
            </>
          }
          trailing={
            <ContextUsage key={`context:${chatKey}`} tokenUsage={view?.tokenUsage}
              panel={contextPanel?.key === chatKey ? contextPanel.panel : null}
              onPanelChange={(panel) => setContextPanel(panel ? { key: chatKey, panel } : null)}
              compact={selectedThreadId ? {
                busy: compacting,
                blockedReason: compactionBlockedReason,
                willQueue: compactionWillQueue,
                onCompact: () => void compactConversation(),
              } : undefined} />
          }
        />
      </div>
      {switching && <SessionSwitcher onClose={() => setSwitching(false)} />}
      {activeCommand === 'help' && <Dialog title={t('对话命令')} onClose={closeCommand}>
        <ul className="space-y-2">{chatCommands.filter(({ id }) => !MOBILE_HIDDEN_COMMANDS.includes(id)).map(({ id, name, description }) => (
          <li key={name}><span className="font-medium">/{name}</span> <span className="text-sm text-qn-muted">{commandReason(id) ?? description}</span></li>
        ))}</ul>
      </Dialog>}
      {activeCommand === 'status' && selectedTargetId && <Dialog title={t('{agent} 额度', { agent: agentLabel(selectedAgent) })} onClose={closeCommand}>
        <AgentQuota targetId={selectedTargetId} agent={selectedAgent} showUsage />
      </Dialog>}
      {activeCommand === 'permissions' && <Dialog title={t('会话访问权限')} onClose={closeCommand}>
        <p className="text-sm">{sessionAccessOptions(selectedAgent).find((option) => option.mode === accessMode)?.label ?? t('pi 不经审批直接执行工具')}</p>
        <p className="text-sm text-qn-muted">{sessionAccessOptions(selectedAgent).find((option) => option.mode === accessMode)?.hint}</p>
      </Dialog>}
      {(activeCommand === 'rename' || activeCommand === 'archive' || activeCommand === 'fork') && (
        <Dialog title={activeCommand === 'rename' ? t('重命名会话') : activeCommand === 'archive' ? t('归档会话') : t('创建会话分支')} onClose={closeCommand}>
          <form onSubmit={(event) => { event.preventDefault(); void confirmCommand(activeCommand) }}>
            {activeCommand === 'rename'
              ? <input className="qn-input w-full" aria-label={t('会话名称')} value={commandName} onChange={(event) => setCommandName(event.target.value)} />
              : <p className="text-sm text-qn-muted">{activeCommand === 'archive' ? t('可在已归档会话中恢复。') : t('从当前会话复制上下文并打开新分支。')}</p>}
            {commandMessage && <Note tone="error" message={commandMessage} />}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={closeCommand}>{t('取消')}</Button>
              <Button type="submit" variant="primary" disabled={commandPending || (activeCommand === 'rename' && !commandName.trim())}>{t('确认')}</Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  )
}

/** 会话切换按钮：长短两道横线，比侧栏图标更轻，表达“打开会话列表”。 */
function MenuLinesIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 8h16M4 16h10" />
    </svg>
  )
}

function TurnInterrupted({ announce }: { announce: boolean }) {
  return <div className="qn-turn-interrupted" role={announce ? 'status' : undefined}><span className="qn-turn-interrupted-icon" aria-hidden />{t('本轮已中断')}</div>
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
      {detail && <div className="mt-1 text-xs whitespace-pre-wrap">{translateMessage(detail)}</div>}
    </div>
  )
}
