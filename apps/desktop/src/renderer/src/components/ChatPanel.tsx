import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type UIEvent } from 'react'
import { ArrowDown, FolderGit2, ImagePlus, Monitor, Server } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { CodexRpcLike, ItemView, ThreadView } from '@qn/codex-client'
import { accessOptions, chatCommands, chatCommandUnavailable, claudeQuotaBlocked, collectSubagents, contextUsage, DRAFT_THREAD_ID,
  estimatedTurnUsage, formatTokens, includeWorkSummary, type ChatCommandId } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { buildAnnotatedMessage, sideChatExcerpt, type Annotation } from '../lib/annotations'
import { agentLabel, sessionKey } from '../lib/agents'
import {
  attachmentsBlocking,
  buildUserInput,
  insertImagePlaceholders,
  isImageFile,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  removePlaceholder,
  stripImagePlaceholders,
  uniqueImageName,
  type Attachment,
  type SkillRef,
  type SlashItem,
} from '../lib/attachments'
import { readImage, uploadToTarget } from '../lib/attachmentIo'
import { getAccessMode } from '../features/access/accessModel'
import { screenFiles, useImageSupport } from '../features/composer'
import { useSettings } from '../features/settings/settingsStore'
import { formatCost } from '../lib/claudeUsage'
import { copyText } from '../lib/clipboard'
import { isAtBottom } from '../lib/diff'
import { friendlyError } from '../lib/errors'
import { targetDotClass } from '../lib/targetStatus'
import { threadKey } from '../lib/threads'
import { groupTurns, hasPendingSubmission, needsTurnProgress, streamingReplyId } from '../lib/turnGroups'
import { composerDraftKey, currentThreadApprovals, currentThreads, pendingSendKey, useCodex, type SendMode } from '../store/codex'
import { useDock } from '../store/dock'
import { useProjects } from '../store/projects'
import { useRateLimits } from '../store/rateLimits'
import { skillsKey, useSkills } from '../store/skills'
import { useTargets } from '../store/targets'
import { useThreadPrefs } from '../store/threadPrefs'
import { useUi } from '../store/ui'
import { AgentPicker } from './AgentPicker'
import { AnnotationBar } from './AnnotationBar'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { LoadingIcon } from './LoadingIcon'
import { MessageItem, ToolGroup, TurnProgress, TurnStopped, WorkGroup } from './MessageItem'
import { ContextRing, ModelPicker } from './ModelPicker'
import { RateLimitDetails } from './RateLimitBadge'
import { SelectionLayer } from './SelectionLayer'
import { SendQueue } from './SendQueue'
import { StatusDot } from './StatusDot'
import { TargetMetrics } from './TargetMetrics'
import { MainHeader } from './shell/MainHeader'
import { WelcomePane } from './shell/WelcomePane'
import { SubagentLauncher } from './SubagentDetails'
import { TurnErrorNote } from './TurnErrorNote'
import { TurnNavigation } from './TurnNavigation'
import { EmptyState, ErrorNote, Modal } from './ui'

const HISTORY_BATCH_SIZE = 60

type Draft = {
  text: string
  annotations: Annotation[]
  attachments: Attachment[]
  skills: Partial<Record<AgentKind, SkillRef[]>>
}
const emptyDraft: Draft = { text: '', annotations: [], attachments: [], skills: {} }
const emptySkills: SkillRef[] = []
const noItems: ItemView[] = []

function hasDraft(draft: Draft): boolean {
  return !!(draft.text || draft.annotations.length || draft.attachments.length ||
    Object.values(draft.skills).some((skills) => skills?.length))
}

const ChatSubagents = memo(function ChatSubagents({ sessionId, threadId, items, rpc }: {
  sessionId: string
  threadId: string
  items: readonly ItemView[]
  rpc: CodexRpcLike | null
}) {
  const referenced = useMemo(() => {
    const ids = new Set<string>()
    for (const item of items) {
      if (item.kind !== 'subagent') continue
      for (const agent of item.agents ?? []) ids.add(agent.threadId)
    }
    return ids
  }, [items])
  // 子代理正文需要实时更新，但只影响入口和详情，主对话无需重绘。
  const threads = useCodex(useShallow((s) => {
    const all = s.sessions[sessionId]?.state.threads
    if (!all) return undefined
    const related: Record<string, ThreadView> = Object.create(null)
    for (const id of Object.keys(all)) {
      const thread = all[id]!
      if (thread.subagent?.parentThreadId === threadId || referenced.has(id)) related[id] = thread
    }
    return related
  }))
  const entries = useMemo(() => collectSubagents(items, threadId, threads), [items, threadId, threads])
  if (!entries.length) return null
  return <SubagentLauncher entries={entries} threads={threads} rpc={rpc}
    renderItem={(item, showStreamingDots) => <MessageItem key={item.id} item={item} showStreamingDots={showStreamingDots} />} />
})

export function ChatPanel({ visible = true, onConnect, onAddTarget }: {
  visible?: boolean
  onConnect: (id: string) => void
  onAddTarget: () => void
}) {
  const targets = useTargets((s) => s.targets)
  const currentTargetId = useCodex((s) => s.currentTargetId)
  const targetState = useTargets((s) => s.states[currentTargetId ?? '']?.state ?? 'idle')
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentAgent = useCodex((s) => s.currentAgent)
  const openingThread = useCodex((s) => s.openingThread)
  const sending = useCodex((s) => s.sending)
  const error = useCodex((s) => s.error)
  const clearError = useCodex((s) => s.clearError)
  const send = useCodex((s) => s.send)
  const sendRevision = useCodex((s) => s.sendRevision)
  const interrupt = useCodex((s) => s.interrupt)
  const respondApproval = useCodex((s) => s.respondApproval)
  const ensureOpen = useCodex((s) => s.ensureOpen)
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const openSideChat = useCodex((s) => s.openSideChat)
  const startDraft = useCodex((s) => s.startDraft)
  const currentCwd = useCodex((s) => s.currentCwd)
  const selectedProjectId = useProjects((s) => s.selectedId)
  const projects = useProjects((s) => s.projects)
  const chatWidth = useUi((s) => s.chatWidth)
  const contentWidthClassName = chatWidth === 'wide' ? 'max-w-5xl' : 'max-w-3xl'

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const historyScroll = useRef<{ key: string | null; height: number; top: number } | null>(null)
  const turnJump = useRef<{ key: string | null; id: string } | null>(null)
  const annotationCounter = useRef(0)
  const [pinned, setPinned] = useState(true)
  const [historyStart, setHistoryStart] = useState<{ key: string | null; index: number } | null>(null)
  const [historyLoad, setHistoryLoad] = useState<{ key: string | null; error?: string } | null>(null)
  const loadEarlierHistory = useCodex((s) => s.loadEarlierHistory)
  const draftKey = useCodex(composerDraftKey)
  const [commandDialog, setCommandDialog] = useState<{ key: string; id: ChatCommandId } | null>(null)
  const [commandFeedback, setCommandFeedback] = useState<{ key: string; message: string } | null>(null)
  const [commandName, setCommandName] = useState('')
  const [commandPending, setCommandPending] = useState(false)
  const activeCommand = commandDialog?.key === draftKey ? commandDialog.id : null
  const commandMessage = commandFeedback?.key === draftKey ? commandFeedback.message : null
  const sendingDraftKey = useRef<string | null>(null)
  const [startingPiDraft, setStartingPiDraft] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const { text: draft, annotations, attachments, skills: draftSkills } = drafts[draftKey] ?? emptyDraft
  const skills = draftSkills[currentAgent] ?? emptySkills
  const updateDraft = (change: (previous: Draft) => Draft, key = draftKey) => {
    if (key.startsWith('draft:') && key !== composerDraftKey(useCodex.getState()) && key !== sendingDraftKey.current) {
      return
    }
    setDrafts((previous) => {
      const next = change(previous[key] ?? emptyDraft)
      const drafts = { ...previous }
      if (hasDraft(next)) drafts[key] = next
      else delete drafts[key]
      return drafts
    })
  }
  const setDraft = (value: string) => updateDraft((item) => ({ ...item, text: value }))
  const setAnnotations = (change: (items: Annotation[]) => Annotation[]) =>
    updateDraft((item) => ({ ...item, annotations: change(item.annotations) }))
  const [highlights, setHighlights] = useState<Record<string, Range>>({})
  const highlightRanges = useMemo(() => Object.values(highlights), [highlights])
  const setAttachments = (change: (items: Attachment[]) => Attachment[]) =>
    updateDraft((item) => ({ ...item, attachments: change(item.attachments) }))
  const [readingImages, setReadingImages] = useState(0)
  const attachmentReads = useRef(new Map<string, Set<string>>())
  const attachmentsUploading = attachments.some((item) =>
    item.kind === 'file' && (item.status === 'pending' || item.status === 'uploading'),
  )
  const setSkills = (skills: SkillRef[]) =>
    updateDraft((item) => ({ ...item, skills: { ...item.skills, [currentAgent]: skills } }))
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const imageSupport = useImageSupport(currentTargetId, currentAgent, !!currentTargetId)

  const sessionId = currentTargetId ? sessionKey(currentTargetId, currentAgent) : null
  const { opening, opened, openError, directory, rpc } = useCodex(useShallow((s) => {
    const session = sessionId ? s.sessions[sessionId] : undefined
    return {
      opening: session?.opening, opened: session?.opened, openError: session?.openError,
      directory: session?.openedConfig?.directory, rpc: session?.rpc,
    }
  }))
  // 草稿态没有 threadId，发送中的用户消息先放在草稿线程里，避免对话区空白。
  const visibleThreadId = currentThreadId ?? DRAFT_THREAD_ID
  const chatKey = currentTargetId ? pendingSendKey({ targetId: currentTargetId, agent: currentAgent, threadId: visibleThreadId }) : null
  const sendingMessage = useCodex((s) => s.sendingMessage?.key === chatKey ? s.sendingMessage : null)
  const sendingQueued = useCodex((s) => !!(chatKey && s.pendingSends[chatKey]?.[0]?.sending))
  const queued = useCodex((s) => !!(chatKey && s.pendingSends[chatKey]?.length))
  const compactionStarting = useCodex((s) => !!(chatKey && s.compacting[chatKey]))
  const quota = useRateLimits((s) => {
    if (currentAgent === 'claude') return sessionId ? s.byAgent[sessionId]?.snapshot : null
    return currentAgent === 'codex' && currentTargetId ? s.byTarget[currentTargetId]?.snapshot : null
  })
  const view = useCodex((s) => sessionId ? s.sessions[sessionId]?.state.threads[visibleThreadId] : undefined)
  const preview = sendingMessage?.preview
  const items: ItemView[] = useMemo(() => preview ? [...(view?.items ?? noItems), preview] : view?.items ?? noItems, [preview, view?.items])
  const revisionTurnId = useThreadPrefs((s) => currentTargetId && currentThreadId
    ? s.byTarget[currentTargetId]?.revisionTurns[threadKey(currentAgent, currentThreadId)]
    : undefined)
  const revisionTurn = revisionTurnId ? view?.turns?.find((turn) => turn.id === revisionTurnId) : undefined
  const revisionItemId = revisionTurn && (items.find((item) => item.kind === 'user' && revisionTurn.itemIds.includes(item.id))?.id
    ?? (view?.activeTurnId === revisionTurn.id ? view.items.find((item) => item.kind === 'user' && item.pending)?.id : undefined))
  const revisionChat = currentAgent === 'codex' && currentTargetId && currentThreadId
    ? { targetId: currentTargetId, agent: currentAgent, threadId: currentThreadId } as const : null
  const approvals = useCodex(currentThreadApprovals)
  const running = view?.status === 'running'
  const activeItems = running ? view.turns?.find((turn) => turn.id === view.activeTurnId)?.itemIds : undefined
  const compacting = compactionStarting || items.some((item) => item.kind === 'other' &&
    item.type === 'contextCompaction' && item.status === 'inProgress' && activeItems?.includes(item.id))
  const streamingId = streamingReplyId(view)
  const interrupted = !running && view?.activity === 'interrupted'
  const flow = useMemo(() => groupTurns(items, view?.turns, running),
    [items, view?.turns, running])
  const defaultStart = Math.max(0, flow.length - HISTORY_BATCH_SIZE)
  const firstVisible = includeWorkSummary(flow, historyStart?.key === chatKey ? Math.min(historyStart.index, defaultStart) : defaultStart)
  const visibleFlow = flow.slice(firstVisible)
  const showProgress = approvals.length === 0 && !openError
    && (running ? needsTurnProgress(view, visibleFlow) : hasPendingSubmission(items, !!sendingMessage || sendingQueued))
  const empty = items.length === 0 && flow.length === 0 && approvals.length === 0 && !running && !showProgress
  const historyLoading = historyLoad?.key === chatKey && historyLoad.error === undefined
  const historyError = historyLoad?.key === chatKey ? historyLoad.error : undefined

  // 换会话后原消息节点会卸载，引用文本仍由对应的草稿保存。
  useLayoutEffect(() => {
    setHighlights({})
  }, [draftKey])

  // 切换会话时回到底部，不沿用上一个会话的滚动位置。
  useLayoutEffect(() => {
    setPinned(true)
  }, [currentTargetId, currentAgent, currentThreadId])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!pinned || !scroll || !content) return

    // 图片、折叠工具组和输入框都会改变可见范围，在浏览器绘制前跟随底部。
    const followBottom = () => {
      scroll.scrollTop = scroll.scrollHeight
    }
    followBottom()
    const observer = new ResizeObserver(followBottom)
    observer.observe(scroll)
    observer.observe(content)
    return () => observer.disconnect()
  }, [pinned, currentTargetId, currentAgent, currentThreadId])

  useLayoutEffect(() => {
    const previous = historyScroll.current
    historyScroll.current = null
    const scroll = scrollRef.current
    if (scroll && previous?.key === chatKey) scroll.scrollTop = previous.top + scroll.scrollHeight - previous.height

    const jump = turnJump.current
    turnJump.current = null
    if (!scroll || !jump || jump.key !== chatKey) return
    const anchor = [...scroll.querySelectorAll<HTMLElement>('[data-turn-anchor]')]
      .find((node) => node.dataset.turnAnchor === jump.id)
    if (anchor) {
      // 只滚动消息区，保留外层工作区和其他面板的位置。
      scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12
      setPinned(isAtBottom(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight, 1))
    }
  }, [chatKey, firstVisible, historyStart, view?.historyCursor])

  const jumpToTurn = (id: string, index: number) => {
    turnJump.current = { key: chatKey, id }
    // 对应轮次可能在本地已读取，却还没渲染。挂载该轮次后再定位。
    setHistoryStart({ key: chatKey, index: Math.min(firstVisible, index) })
  }

  const showEarlier = async () => {
    if (historyLoading) return
    const reveal = () => {
      const scroll = scrollRef.current
      if (scroll) historyScroll.current = { key: chatKey, height: scroll.scrollHeight, top: scroll.scrollTop }
      setPinned(false)
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
      setHistoryLoad((current) => current === load ? { ...load, error: friendlyError(error, '加载历史失败') } : current)
    }
  }

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget
    setPinned(isAtBottom(node.scrollTop, node.scrollHeight, node.clientHeight))
  }

  const scrollToBottom = () => {
    setPinned(true)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }

  const sendAndFollow: typeof send = (text, options) => {
    scrollToBottom()
    return send(text, options)
  }

  const addAnnotation = (quote: string, comment: string, range: Range) => {
    annotationCounter.current += 1
    const id = `annotation-${annotationCounter.current}`
    setAnnotations((prev) => [...prev, { id, quote, comment }])
    setHighlights((prev) => ({ ...prev, [id]: range }))
  }

  const removeAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((item) => item.id !== id))
    setHighlights((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const submit = async (text: string, mode: SendMode): Promise<boolean> => {
    const message = buildAnnotatedMessage(annotations, stripImagePlaceholders(text, attachments))
    const input = buildUserInput(message, attachments, skills)
    const newDraft = currentThreadId === null
    if (input.length === 0 || (newDraft && sendingDraftKey.current)) return false
    let createdKey: string | null = null
    let accepted: boolean
    if (newDraft) sendingDraftKey.current = draftKey
    try {
      accepted = await sendAndFollow(message, { input, mode, onThreadCreated: (threadId) => {
        createdKey = JSON.stringify([currentTargetId, currentCwd, currentAgent, threadId])
      } })
    } finally {
      if (newDraft) sendingDraftKey.current = null
    }
    const restoreDraft = !newDraft || createdKey !== null || draftKey === composerDraftKey(useCodex.getState())
    // 新草稿的第一轮可能在建会话后发送失败，重试内容要留在已创建的会话里。
    setDrafts((previous) => {
      const source = previous[draftKey]
      if (!source) return previous
      const next = { ...previous }
      delete next[draftKey]
      const unsent = accepted ? {
        text: source.text === text ? '' : stripImagePlaceholders(source.text, attachments),
        annotations: source.annotations.filter((item) => !annotations.includes(item)),
        attachments: source.attachments.filter((item) => !attachments.includes(item)),
        skills: {
          ...source.skills,
          [currentAgent]: source.skills[currentAgent]?.filter((item) => !skills.includes(item)),
        },
      } : source
      const remaining = createdKey ? { ...unsent, skills: { [currentAgent]: unsent.skills[currentAgent] } } : unsent
      if (restoreDraft && hasDraft(remaining)) {
        const key = createdKey ?? draftKey
        const dest = next[key]
        next[key] = dest ? {
          text: [remaining.text, dest.text].filter(Boolean).join('\n\n'),
          annotations: [...remaining.annotations, ...dest.annotations],
          attachments: [...remaining.attachments, ...dest.attachments],
          skills: {
            [currentAgent]: [...new Set([...(remaining.skills[currentAgent] ?? []), ...(dest.skills[currentAgent] ?? [])])],
          },
        } : remaining
      }
      return next
    })
    if (!accepted) return false
    setHighlights((previous) => Object.fromEntries(Object.entries(previous)
      .filter(([id]) => !annotations.some((item) => item.id === id))))
    return true
  }

  const notify = (message: string) => useCodex.setState({ notice: message })

  const preparePiDraft = async () => {
    if (sendingDraftKey.current || attachmentReads.current.has(draftKey) || attachmentsUploading) return
    sendingDraftKey.current = draftKey
    setStartingPiDraft(draftKey)
    try {
      await useCodex.getState().newThread('pi', (threadId) => {
        const threadKey = JSON.stringify([currentTargetId, currentCwd, 'pi', threadId])
        setDrafts((previous) => {
          const draft = previous[draftKey]
          if (!draft) return previous
          const next = { ...previous, [threadKey]: draft }
          delete next[draftKey]
          return next
        })
      })
    } finally {
      sendingDraftKey.current = null
      setStartingPiDraft(null)
    }
  }

  const patchAttachment = (id: string, patch: Partial<Attachment>) =>
    setAttachments((prev) => prev.map((item) => (item.id === id ? ({ ...item, ...patch } as Attachment) : item)))

  /** 返回通过附件校验的图片名，供输入框插入占位。 */
  const addFiles = (files: File[]): string[] => {
    if (!currentTargetId || sending || (!currentThreadId && sendingDraftKey.current)) return []
    const targetId = currentTargetId
    const pending = attachmentReads.current.get(draftKey) ?? new Set<string>()
    const reads = pending.size
    const { accepted, rejected } = screenFiles(files, {
      existingImages: attachments.filter((item) => item.kind === 'image').length + reads,
      imagesAllowed: imageSupport.allowed,
      unsupportedReason: imageSupport.reason ?? undefined,
    })
    if (rejected.length > 0) {
      const detail = rejected.map((item) => `${item.name}：${item.reason}`).join('；')
      notify(`未添加 ${rejected.length} 张图片（${detail}）`)
    }
    if (accepted.length === 0) return []
    const room = MAX_ATTACHMENTS - attachments.length - reads
    if (room <= 0) {
      notify('最多添加 ' + MAX_ATTACHMENTS + ' 个附件')
      return []
    }
    if (accepted.length > room) notify('最多添加 ' + MAX_ATTACHMENTS + ' 个附件，已忽略多出的 ' + (accepted.length - room) + ' 个')
    // 只有本机目标能直接引用本机路径；SSH 与直连目标都要先上传。
    const isLocal = targets.find((item) => item.id === targetId)?.kind === 'local'
    const taken = new Set([...pending, ...attachments.map((item) => item.name)])
    for (const [, name] of draft.matchAll(/\[([^\]\n]+)\]/g)) if (name) taken.add(name)
    const imageNames: string[] = []
    for (const file of accepted.slice(0, room)) {
      const id = 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
      if (isImageFile(file)) {
        const name = uniqueImageName(file.name, taken)
        taken.add(name)
        imageNames.push(name)
        pending.add(name)
        attachmentReads.current.set(draftKey, pending)
        setReadingImages(pending.size)
        void readImage(file)
          .then(({ dataUrl, size }) => {
            setAttachments((prev) => [...prev, { id, kind: 'image', name, size, dataUrl }])
          })
          .catch((err: unknown) => {
            updateDraft((item) => ({ ...item, text: removePlaceholder(item.text, name) }))
            if (draftKey === composerDraftKey(useCodex.getState())) {
              notify(name + '：' + (err instanceof Error ? err.message : '读取失败'))
            }
          })
          .finally(() => {
            pending.delete(name)
            if (!pending.size) attachmentReads.current.delete(draftKey)
            if (draftKey === composerDraftKey(useCodex.getState())) setReadingImages(pending.size)
          })
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        notify(file.name + ' 超过 ' + MAX_FILE_BYTES / 1024 / 1024 + ' MB，未添加')
        continue
      }
      const localPath = window.qn?.pathForFile?.(file) ?? ''
      if (isLocal && localPath) {
        setAttachments((prev) => [
          ...prev,
          { id, kind: 'file', name: file.name, size: file.size, localPath, targetPath: localPath, status: 'ready' },
        ])
        continue
      }
      setAttachments((prev) => [
        ...prev,
        { id, kind: 'file', name: file.name, size: file.size, localPath, targetPath: null, status: 'uploading' },
      ])
      uploadToTarget(targetId, file)
        .then((path) => patchAttachment(id, { status: 'ready', targetPath: path }))
        .catch((err: unknown) =>
          patchAttachment(id, { status: 'error', error: err instanceof Error ? err.message : '上传失败' }),
        )
    }
    return imageNames
  }

  const removeAttachment = (id: string) => updateDraft((item) => {
    const attachment = item.attachments.find((entry) => entry.id === id)
    return {
      ...item,
      text: attachment?.kind === 'image' ? removePlaceholder(item.text, attachment.name) : item.text,
      attachments: item.attachments.filter((entry) => entry.id !== id),
    }
  })

  // 拖入文件：dragenter/leave 在子元素间会成对触发，用计数判断是否真正离开主区。
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event) || !currentTargetId) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return
    dragDepth.current = 0
    setDragging(false)
    if (event.defaultPrevented) return
    event.preventDefault()
    const names = addFiles([...event.dataTransfer.files])
    if (names.length > 0) {
      updateDraft((item) => ({
        ...item,
        text: insertImagePlaceholders(item.text, names).value,
      }))
    }
  }

  const forkThread = useCodex((s) => s.forkThread)
  const forkFromMessage = (itemId: string) => {
    const turn = view?.turns?.find((candidate) => candidate.itemIds.includes(itemId))
    if (!currentThreadId || !turn || turn.id === view?.activeTurnId) return
    return () => void forkThread(currentThreadId, currentAgent, turn.id)
  }

  const target = targets.find((item) => item.id === currentTargetId)
  const project = projects.find((item) => item.id === selectedProjectId)
  const TargetIcon = target && target.kind !== 'local' ? Server : Monitor
  const isDraft = !currentThreadId
  const preparingPi = startingPiDraft === draftKey

  const skillKey = currentTargetId ? skillsKey(currentTargetId, currentAgent, currentCwd, directory) : null
  const skillList = useSkills((s) => skillKey ? s.lists[skillKey] : undefined)
  const loadSkills = useSkills((s) => s.load)
  const skillRpc = opened ? rpc : undefined
  const refreshClaudeSkills = currentAgent === 'claude' && !running
  useEffect(() => {
    if (skillKey && skillRpc) void loadSkills(skillKey, currentCwd, skillRpc, refreshClaudeSkills)
  }, [skillKey, currentCwd, skillRpc, loadSkills, refreshClaudeSkills])

  const threads = useCodex(currentThreads)
  const localTitle = useThreadPrefs((s) => currentTargetId && currentThreadId
    ? s.byTarget[currentTargetId]?.names[threadKey(currentAgent, currentThreadId)]
    : undefined)
  const usage = contextUsage(view?.tokenUsage)
  const turnUsage = estimatedTurnUsage(view?.tokenUsage)
  const latestReply = items.findLast((item) => item.kind === 'agent' && !item.streaming && item.text.trim())
  const quotaBlocked = currentAgent === 'claude' ? claudeQuotaBlocked(quota) : !!(quota?.rateLimitReachedType || quota?.spendControlReached)
  const compactBlocked = !currentThreadId || !opened || !view || openingThread ? '请先打开会话'
    : running || sending || compacting || approvals.length ? '请先等待当前一轮结束'
    : queued ? '请先处理排队的消息' : quotaBlocked ? '当前额度已用完' : null
  const commandReason = (id: ChatCommandId) => {
    if (id === 'model' && !opened) return '请先连接当前 Agent'
    if (id === 'diff' && !currentCwd) return '请先选择项目'
    return chatCommandUnavailable(id, {
      agent: currentAgent, thread: !!currentThreadId, running,
      busy: sending || compacting || !!openingThread || commandPending, compactBlocked, hasReply: !!latestReply,
    })
  }
  const slashItems: SlashItem[] = [
    ...chatCommands.map(({ id, name, description }) => ({
      id: name, name, description: id === 'refresh' ? '刷新会话列表与技能' : description,
      kind: 'command' as const, reason: commandReason(id),
    })),
    ...(skillList?.items ?? []),
  ]
  const closeCommand = () => setCommandDialog(null)
  const showCommandMessage = (message: string) => setCommandFeedback({ key: draftKey, message })
  const showCommand = (id: ChatCommandId) => setCommandDialog({ key: draftKey, id })

  const runCommand = (name: string) => {
    const command = chatCommands.find((entry) => entry.name === name)
    if (!command) return
    const { id } = command
    const blocked = commandReason(id)
    if (blocked) { showCommandMessage(blocked); return }
    setCommandFeedback(null)
    switch (id) {
      case 'new': startDraft(currentAgent); return
      case 'stop': void interrupt(); return
      case 'refresh':
        void refreshThreads()
        if (skillKey && skillRpc) void loadSkills(skillKey, currentCwd, skillRpc, true)
        return
      case 'diff': useDock.getState().showTool('git'); return
      case 'resume':
        if (project && project.targetId === currentTargetId && project.path === currentCwd) {
          useProjects.getState().setExpanded(project, true)
          useUi.getState().revealThreadList({ targetId: project.targetId, projectId: project.id, threadKey: null })
          return
        }
        break
      case 'rename':
        setCommandName(localTitle ?? threads.find((thread) => thread.agent === currentAgent && thread.id === currentThreadId)?.title ?? '')
        break
      case 'copy':
        if (latestReply?.kind === 'agent') void copyText(latestReply.text).then((ok) => showCommandMessage(ok ? '已复制最近一条回复' : '复制失败'))
        return
    }
    showCommand(id)
  }

  async function confirmCommand(id: 'rename' | 'archive' | 'fork' | 'compact') {
    if (!currentTargetId || !currentThreadId || commandReason(id)) return
    const name = commandName.trim()
    if (id === 'rename' && !name) return
    const state = useCodex.getState()
    setCommandPending(true)
    if (id === 'compact') closeCommand()
    try {
      if (id === 'compact') await state.compactConversation()
      else {
        let ok: boolean
        if (id === 'archive') ok = await state.archiveThread(currentThreadId, currentAgent)
        else if (id === 'fork') ok = await state.forkThread(currentThreadId, currentAgent)
        else {
          ok = currentAgent !== 'codex' || await state.renameThread(currentThreadId, currentAgent, name)
          if (ok) useThreadPrefs.getState().setLocalName(currentTargetId, threadKey(currentAgent, currentThreadId), currentAgent === 'codex' ? null : name)
        }
        if (!ok) { showCommandMessage(useCodex.getState().error ?? '会话操作失败'); return }
        setCommandDialog((current) => current?.key === draftKey && current.id === id ? null : current)
      }
    } finally {
      setCommandPending(false)
    }
  }

  const accessMode = useCodex((state) => currentTargetId ? getAccessMode(state.access,
    { targetId: currentTargetId, agent: currentAgent, threadId: currentThreadId },
    useSettings.getState().settings.general.globalAccessMode) : 'default')
  const access = accessOptions[currentAgent].find((option) => option.mode === accessMode)

  // 切换草稿后只跟踪当前输入框的读图进度。
  useLayoutEffect(() => {
    setReadingImages(attachmentReads.current.get(draftKey)?.size ?? 0)
    // 已开始发送的新草稿保留到 RPC 完成，以便把失败的输入留给刚创建的会话。
    const pendingKey = sendingDraftKey.current
    setDrafts((previous) => {
      const entries = Object.entries(previous)
      const kept = entries.filter(([key]) => !key.startsWith('draft:') || key === draftKey || key === pendingKey)
      return kept.length === entries.length ? previous : Object.fromEntries(kept)
    })
  }, [draftKey])
  const agentStatus = opening
    ? `${agentLabel(currentAgent)} 启动中…`
    : openError && !opened
      ? `${agentLabel(currentAgent)} 不可用`
      : null

  return (
    <main
      className="qn-enter relative flex min-h-0 min-w-0 flex-1 flex-col bg-qn-bg [container-type:size]"
      style={{ ['--qn-enter-order' as string]: 2 }}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (hasFiles(event)) event.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <MainHeader subagents={currentThreadId && sessionId && (
        <ChatSubagents key={chatKey} sessionId={sessionId} threadId={currentThreadId} items={view?.items ?? noItems} rpc={skillRpc ?? null} />
      )} />

      {openingThread && (
        <div className="flex items-center gap-2 border-b border-qn-border px-6 py-2 text-ui-md text-qn-muted" role="status">
          <LoadingIcon size={14} aria-hidden /> 正在加载会话历史…
        </div>
      )}

      <div className="relative flex min-h-12 flex-1">
        <SelectionLayer
          containerRef={scrollRef}
          layoutKey={JSON.stringify([chatWidth, draftKey])}
          className={`qn-scroll min-w-0 flex-1 overflow-y-auto px-6 pb-6 pt-2 [scrollbar-gutter:stable_both-edges]${pinned ? ' [overflow-anchor:none]' : ''}`}
          onScroll={onScroll}
          highlights={highlightRanges}
          onAdd={addAnnotation}
          showSideAction={!!currentThreadId}
          onSide={(text, itemId) => openSideChat(sideChatExcerpt(items, { text, itemId }))}
        >
          <div ref={contentRef} className={`mx-auto flex min-h-full flex-col ${contentWidthClassName}`}>
            {openError && (
              <div className="mb-3">
                <ErrorNote
                  message={openError}
                  onRetry={() => {
                    if (currentTargetId) {
                      void ensureOpen(currentTargetId, currentAgent).then(() => void refreshThreads())
                    }
                  }}
                />
              </div>
            )}
            {!running && !interrupted && view?.error && (
              <div className="mb-3">
                <TurnErrorNote error={view.error} />
              </div>
            )}

            {isDraft && empty ? (
              <div className="flex flex-1 flex-col">
                <WelcomePane onConnect={onConnect} onAddTarget={onAddTarget} />
              </div>
            ) : empty && !view?.historyCursor ? (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState>会话暂无消息，发送一条开始对话。</EmptyState>
              </div>
            ) : (
              <div className="space-y-4 pt-4">
                {(firstVisible > 0 || view?.historyCursor) && (
                  <button type="button" className="mx-auto block rounded-full px-3 py-1.5 text-ui-md text-qn-muted hover:bg-qn-hover" disabled={historyLoading} onClick={() => void showEarlier()}>
                    {historyLoading ? '正在加载更早消息…' : '查看更早消息'}
                  </button>
                )}
                {historyError && <div role="alert" className="text-center text-ui-md text-qn-danger">{historyError}</div>}
                {visibleFlow.map((entry, index) => {
                  const previous = visibleFlow[index - 1]
                  if (entry.kind === 'tools') return <ToolGroup key={entry.key} items={entry.items} />
                  if (entry.kind === 'work') {
                    return <WorkGroup key={entry.key} durationMs={entry.durationMs} entries={entry.entries}
                      replyCompletedAtMs={entry.reply?.completedAtMs} onFork={forkFromMessage} />
                  }
                  if (entry.kind === 'stopped') return <TurnStopped key={entry.key} durationMs={entry.durationMs} />
                  const key = `${currentTargetId}:${currentAgent}:${currentThreadId}:${entry.key}`
                  const message = (
                    <MessageItem
                      key={key}
                      item={entry.item}
                      showStreamingDots={entry.item.id === streamingId}
                      replyTimeInSummary={previous?.kind === 'work' && previous.reply?.id === entry.item.id}
                      onFork={forkFromMessage}
                      showRevisionMarker={entry.item.id === revisionItemId}
                      editRestartsConversation={!!revisionChat}
                      onEdit={revisionChat
                        ? (_text, input) => sendRevision(revisionChat, entry.item.id, input)
                        : (text, input) => sendAndFollow(text, { input })}
                    />
                  )
                  return entry.item.kind === 'user' ? (
                    <div key={key} data-turn-anchor={entry.key}>{message}</div>
                  ) : message
                })}
                {showProgress && <TurnProgress activity={running ? view.activity : undefined} />}
                {currentTargetId && currentThreadId && approvals.map((approval) => (
                  <ApprovalCard
                    key={String(approval.requestId)}
                    approval={approval}
                    onDecide={(decision) => respondApproval(
                      { targetId: currentTargetId, agent: currentAgent, threadId: currentThreadId },
                      approval.requestId, decision,
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </SelectionLayer>
        {currentThreadId && (
          <TurnNavigation key={chatKey} flow={flow} firstVisible={firstVisible} scrollRef={scrollRef}
            contentRef={contentRef} onJump={jumpToTurn} />
        )}
        {!pinned && (
          <button
            type="button"
            className="qn-surface-float absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-ui-sm hover:bg-qn-hover"
            onClick={scrollToBottom}
          >
            <ArrowDown size={14} /> 回到底部
          </button>
        )}
      </div>

      {/* 队列和注释在剩余空间内滚动，避免把消息列表或输入框挤出窗口。 */}
      <div className="qn-scroll min-h-0 overflow-y-auto">
        <SendQueue
          targetId={currentTargetId}
          agent={currentAgent}
          threadId={currentThreadId}
          running={running}
          allowNewThread
          contentWidthClassName={contentWidthClassName}
        />
        <AnnotationBar annotations={annotations} onRemove={removeAnnotation} contentWidthClassName={contentWidthClassName} />
      </div>
      {commandMessage && !activeCommand && (
        <div role="status" className="mx-auto w-full max-w-3xl px-4 py-1 text-ui text-qn-muted">{commandMessage}</div>
      )}
      <Composer
        key={draftKey}
        suggestionBoundaryRef={scrollRef}
        contentWidthClassName={contentWidthClassName}
        onSend={submit}
        onInterrupt={() => void interrupt()}
        running={running}
        canSteer={!!view?.activeTurnId}
        compacting={compacting}
        sending={sending || preparingPi || compactionStarting}
        disabled={!currentTargetId}
        error={error}
        onClearError={clearError}
        value={draft}
        onChange={setDraft}
        agent={currentAgent}
        annotationCount={annotations.length}
        attach={{
          attachments,
          imageSupport,
          onAddFiles: addFiles,
          onRemoveAttachment: removeAttachment,
          blockedReason: readingImages > 0 ? '正在读取图片…' : attachmentsBlocking(attachments),
        }}
        slash={{
          items: slashItems,
          loading: skillList?.loading,
          skills,
          onSkillsChange: setSkills,
          onCommand: runCommand,
        }}
        leading={<AgentPicker targetId={currentTargetId} agent={currentAgent} locked={!isDraft || sending || preparingPi} />}
        trailing={
          currentTargetId && (
            <>
              <ContextRing tokenUsage={view?.tokenUsage} onClick={currentThreadId ? () => showCommand('context') : undefined} />
              <ModelPicker
                targetId={currentTargetId}
                agent={currentAgent}
                threadId={currentThreadId}
                open={activeCommand === 'model'}
                onOpenChange={(open) => open ? showCommand('model') : closeCommand()}
                piDraft={currentAgent === 'pi' && isDraft ? {
                  start: () => void preparePiDraft(),
                  starting: preparingPi,
                  disabled: sending || preparingPi || readingImages > 0 || attachmentsUploading,
                } : undefined}
              />
            </>
          )
        }
        footer={
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <StatusDot className={targetDotClass[targetState]} />
              <TargetIcon size={13} className="shrink-0" />
              <span className="truncate">{target?.name ?? '未选择目标'}</span>
            </span>
            {project && (
              <span className="flex min-w-0 items-center gap-1.5" title={project.path}>
                <FolderGit2 size={13} className="shrink-0" />
                <span className="truncate font-mono text-ui-xs">{project.path}</span>
              </span>
            )}
            {visible && currentTargetId && targetState === 'ready' && (
              <TargetMetrics key={currentTargetId} targetId={currentTargetId} />
            )}
            {agentStatus && <span className="shrink-0 text-qn-warn">{agentStatus}</span>}
          </>
        }
      />
      {activeCommand === 'help' && <Modal title="对话命令" onClose={closeCommand}>
        <ul className="space-y-2">{chatCommands.map(({ id, name, description }) => (
          <li key={name}><span className="font-medium">/{name}</span> <span className="text-qn-muted">{commandReason(id) ?? description}</span></li>
        ))}</ul>
      </Modal>}
      {activeCommand === 'status' && currentTargetId && <Modal title="账号额度" onClose={closeCommand}>
        <RateLimitDetails targetId={currentTargetId} agent={currentAgent} threadId={currentThreadId} />
      </Modal>}
      {activeCommand === 'context' && <Modal title="会话用量" onClose={closeCommand}>
        <div className="space-y-2">
          {usage && <p>上下文已用 {usage.percent}% · {formatTokens(usage.used)} / {formatTokens(usage.window)} tokens</p>}
          {turnUsage?.tokens != null && <p>最近上报的单轮用量 {formatTokens(turnUsage.tokens)} tokens</p>}
          {turnUsage?.costUsd != null && <p>费用估算 {formatCost(turnUsage.costUsd)}</p>}
          {!usage && !turnUsage && <p className="text-qn-muted">暂无会话用量</p>}
          {currentThreadId && <>
            <button type="button" className="qn-button" disabled={!!compactBlocked} onClick={() => showCommand('compact')}>压缩会话</button>
            {compactBlocked && <p className="text-qn-muted">{compactBlocked}</p>}
          </>}
        </div>
      </Modal>}
      {activeCommand === 'permissions' && <Modal title="会话访问权限" onClose={closeCommand}>
        <p>{access?.label ?? 'pi 不经审批直接执行工具'}</p>
        {access && <p className="text-qn-muted">{access.hint}</p>}
      </Modal>}
      {activeCommand === 'resume' && <Modal title="切换会话" onClose={closeCommand}>
        {threads.length === 0 && <EmptyState>当前目标暂无会话</EmptyState>}
        {threads.map((thread) => (
          <button type="button" key={threadKey(thread.agent, thread.id)} className="qn-button-subtle block w-full truncate text-left"
            onClick={() => { closeCommand(); void useCodex.getState().openThread(thread.id, thread.agent) }}>
            {thread.title} · {agentLabel(thread.agent)}
          </button>
        ))}
      </Modal>}
      {(activeCommand === 'rename' || activeCommand === 'archive' || activeCommand === 'fork' || activeCommand === 'compact') && (
        <Modal title={activeCommand === 'rename' ? '重命名会话' : activeCommand === 'archive' ? '归档会话'
          : activeCommand === 'fork' ? '创建会话分支' : '压缩会话'} onClose={closeCommand}>
          <form onSubmit={(event) => { event.preventDefault(); void confirmCommand(activeCommand) }}>
            {activeCommand === 'rename'
              ? <input className="qn-input w-full" aria-label="会话名称" value={commandName} onChange={(event) => setCommandName(event.target.value)} />
              : <p className="text-qn-muted">{activeCommand === 'archive' ? '可在已归档会话中恢复。'
                : activeCommand === 'fork' ? '从当前会话复制上下文并打开新分支。'
                : '压缩会总结较早的对话，让后续回复使用更短的上下文。账号已用额度不会恢复。'}</p>}
            {commandMessage && <p role="alert" className="mt-2 text-qn-danger">{commandMessage}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="qn-button-subtle" onClick={closeCommand}>取消</button>
              <button type="submit" className="qn-button" disabled={commandPending || (activeCommand === 'rename' && !commandName.trim())}>确认</button>
            </div>
          </form>
        </Modal>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-qn-outline bg-qn-bg/85 text-ui-md text-qn-text">
          <ImagePlus size={28} className="text-qn-accent" />
          松开以添加图片或文件
          <span className="text-ui-sm text-qn-muted">
            图片随消息发送；其他文件{target && target.kind !== 'local' ? '会先上传到目标机' : '按本机路径引用'}
          </span>
        </div>
      )}
    </main>
  )
}
