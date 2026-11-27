import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type UIEvent } from 'react'
import { ArrowDown, FolderGit2, ImagePlus, Monitor, Server } from 'lucide-react'
import type { ItemView } from '@qn/codex-client'
import { collectSubagents, DRAFT_THREAD_ID, supportsSubagentRequests } from '@qn/codex-client'
import type { AgentKind } from '../../../shared/backendApi'
import { buildAnnotatedMessage, quoteBlock, sideChatExcerpt, type Annotation } from '../lib/annotations'
import { agentLabel, sessionKey } from '../lib/agents'
import {
  attachmentsBlocking,
  buildUserInput,
  isImageFile,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  type Attachment,
  type SkillRef,
  type SlashItem,
} from '../lib/attachments'
import { readImage, uploadToTarget } from '../lib/attachmentIo'
import { screenFiles, useImageSupport } from '../features/composer'
import { isAtBottom } from '../lib/diff'
import { friendlyError } from '../lib/errors'
import { targetDotClass } from '../lib/targetStatus'
import { groupTurns, hasPendingSubmission, streamingReplyId } from '../lib/turnGroups'
import { composerDraftKey, currentThreadApprovals, pendingSendKey, useCodex, type SendMode } from '../store/codex'
import { useProjects } from '../store/projects'
import { skillsKey, useSkills } from '../store/skills'
import { useTargets } from '../store/targets'
import { useUi } from '../store/ui'
import { AgentPicker } from './AgentPicker'
import { AnnotationBar } from './AnnotationBar'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { LoadingIcon } from './LoadingIcon'
import { MessageItem, ToolGroup, TurnProgress, TurnStopped, WorkGroup } from './MessageItem'
import { ContextRing, ModelPicker } from './ModelPicker'
import { SelectionLayer } from './SelectionLayer'
import { SendQueue } from './SendQueue'
import { StatusDot } from './StatusDot'
import { MainHeader } from './shell/MainHeader'
import { WelcomePane } from './shell/WelcomePane'
import { SubagentLauncher } from './SubagentDetails'
import { TurnErrorNote } from './TurnErrorNote'
import { EmptyState, ErrorNote } from './ui'

const HISTORY_BATCH_SIZE = 60

type Draft = {
  text: string
  annotations: Annotation[]
  attachments: Attachment[]
  skills: Partial<Record<AgentKind, SkillRef[]>>
}
const emptyDraft: Draft = { text: '', annotations: [], attachments: [], skills: {} }
const emptySkills: SkillRef[] = []

function hasDraft(draft: Draft): boolean {
  return !!(draft.text || draft.annotations.length || draft.attachments.length ||
    Object.values(draft.skills).some((skills) => skills.length))
}

export function ChatPanel({ onConnect, onAddTarget }: { onConnect: (id: string) => void; onAddTarget: () => void }) {
  const targets = useTargets((s) => s.targets)
  const targetState = useTargets((s) => s.states[s.selectedId]?.state ?? 'idle')
  const sessions = useCodex((s) => s.sessions)
  const currentTargetId = useCodex((s) => s.currentTargetId)
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentAgent = useCodex((s) => s.currentAgent)
  const openingThread = useCodex((s) => s.openingThread)
  const sending = useCodex((s) => s.sending)
  const error = useCodex((s) => s.error)
  const clearError = useCodex((s) => s.clearError)
  const send = useCodex((s) => s.send)
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
  const annotationCounter = useRef(0)
  const [pinned, setPinned] = useState(true)
  const [historyStart, setHistoryStart] = useState<{ key: string | null; index: number } | null>(null)
  const [historyLoad, setHistoryLoad] = useState<{ key: string | null; error?: string } | null>(null)
  const loadEarlierHistory = useCodex((s) => s.loadEarlierHistory)
  const draftKey = useCodex(composerDraftKey)
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
  const attachmentReads = useRef(new Map<string, number>())
  const attachmentsUploading = attachments.some((item) =>
    item.kind === 'file' && (item.status === 'pending' || item.status === 'uploading'),
  )
  const setSkills = (skills: SkillRef[]) =>
    updateDraft((item) => ({ ...item, skills: { ...item.skills, [currentAgent]: skills } }))
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const imageSupport = useImageSupport(currentTargetId, currentAgent, !!currentTargetId)

  const session = currentTargetId ? sessions[sessionKey(currentTargetId, currentAgent)] : undefined
  // 草稿态没有 threadId，发送中的用户消息先放在草稿线程里，避免对话区空白。
  const visibleThreadId = currentThreadId ?? DRAFT_THREAD_ID
  const chatKey = currentTargetId ? pendingSendKey({ targetId: currentTargetId, agent: currentAgent, threadId: visibleThreadId }) : null
  const sendingMessage = useCodex((s) => s.sendingMessage?.key === chatKey ? s.sendingMessage : null)
  const sendingQueued = useCodex((s) => !!(chatKey && s.pendingSends[chatKey]?.[0]?.sending))
  const view = session?.state.threads[visibleThreadId]
  const preview = sendingMessage?.preview
  const items: ItemView[] = useMemo(() => preview ? [...(view?.items ?? []), preview] : view?.items ?? [], [preview, view?.items])
  const subagents = useMemo(() => collectSubagents(view?.items ?? [], currentThreadId ?? undefined, session?.state.threads),
    [view?.items, currentThreadId, session?.state.threads])
  const approvals = useCodex(currentThreadApprovals)
  const running = view?.status === 'running'
  const streamingId = streamingReplyId(view)
  const interrupted = !running && view?.activity === 'interrupted'
  const showProgress = approvals.length === 0 && !session?.openError
    && (running || hasPendingSubmission(items, !!sendingMessage || sendingQueued))
  const flow = useMemo(() => groupTurns(items, view?.turns, running),
    [items, view?.turns, running])
  const empty = items.length === 0 && flow.length === 0 && approvals.length === 0 && !running && !showProgress
  const defaultStart = Math.max(0, flow.length - HISTORY_BATCH_SIZE)
  const firstVisible = historyStart?.key === chatKey ? Math.min(historyStart.index, defaultStart) : defaultStart
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
  }, [chatKey, firstVisible, view?.historyCursor])

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
    const message = buildAnnotatedMessage(annotations, text)
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
        text: source.text === text ? '' : source.text,
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

  /** 图片读成 data URL 随消息发送；其他文件本机目标直接引用路径，远端目标先上传到目标机。 */
  const addFiles = (files: File[]) => {
    if (!currentTargetId || sending || (!currentThreadId && sendingDraftKey.current)) return
    const targetId = currentTargetId
    const reads = attachmentReads.current.get(draftKey) ?? 0
    const { accepted, rejected } = screenFiles(files, {
      existingImages: attachments.filter((item) => item.kind === 'image').length + reads,
      imagesAllowed: imageSupport.allowed,
      unsupportedReason: imageSupport.reason ?? undefined,
    })
    if (rejected.length > 0) {
      const detail = rejected.map((item) => `${item.name}：${item.reason}`).join('；')
      notify(`未添加 ${rejected.length} 张图片（${detail}）`)
    }
    if (accepted.length === 0) return
    const room = MAX_ATTACHMENTS - attachments.length - reads
    if (room <= 0) {
      notify('最多添加 ' + MAX_ATTACHMENTS + ' 个附件')
      return
    }
    if (accepted.length > room) notify('最多添加 ' + MAX_ATTACHMENTS + ' 个附件，已忽略多出的 ' + (accepted.length - room) + ' 个')
    // 只有本机目标能直接引用本机路径；SSH 与直连目标都要先上传。
    const isLocal = targets.find((item) => item.id === targetId)?.kind === 'local'
    for (const file of accepted.slice(0, room)) {
      const id = 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
      if (isImageFile(file)) {
        const updateReads = (delta: number) => {
          const count = (attachmentReads.current.get(draftKey) ?? 0) + delta
          if (count) attachmentReads.current.set(draftKey, count)
          else attachmentReads.current.delete(draftKey)
          if (draftKey === composerDraftKey(useCodex.getState())) setReadingImages(count)
        }
        updateReads(1)
        void readImage(file)
          .then(({ dataUrl, size }) => {
            setAttachments((prev) => [...prev, { id, kind: 'image', name: file.name || '粘贴的图片', size, dataUrl }])
          })
          .catch((err: unknown) => {
            if (draftKey === composerDraftKey(useCodex.getState())) {
              notify((file.name || '图片') + '：' + (err instanceof Error ? err.message : '读取失败'))
            }
          })
          .finally(() => updateReads(-1))
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
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((item) => item.id !== id))

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
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles([...event.dataTransfer.files])
  }

  // "从这里开始新会话"：回到草稿态并把引用填进输入框，用户补充后发送才真正建会话。
  const forkThread = useCodex((s) => s.forkThread)
  // 分支到新聊天：Codex 用 thread/fork 截到这条回复所在的轮次，与侧栏"创建聊天分支"同一能力；
  // 其他 Agent 没有分叉 RPC，退化为带引用的新草稿。
  const forkFromMessage = (itemId: string, markdown: string) => {
    const turnId = view?.turns?.find((turn) => turn.itemIds.includes(itemId))?.id
    if (currentAgent === 'codex' && currentThreadId && turnId) {
      void forkThread(currentThreadId, currentAgent, turnId)
      return
    }
    startDraft(currentAgent)
    updateDraft((item) => ({ ...item, text: quoteBlock(markdown) }), composerDraftKey(useCodex.getState()))
  }
  // 进行中的轮次不能分叉（Codex 会拒绝），运行期间先不提供入口。
  const canFork = !(currentAgent === 'codex' && running)

  const target = targets.find((item) => item.id === currentTargetId)
  const project = projects.find((item) => item.id === selectedProjectId)
  const TargetIcon = target && target.kind !== 'local' ? Server : Monitor
  const isDraft = !currentThreadId
  const preparingPi = startingPiDraft === draftKey

  const skillKey = currentTargetId ? skillsKey(currentTargetId, currentAgent, currentCwd, session?.openedConfig?.directory) : null
  const skillList = useSkills((s) => skillKey ? s.lists[skillKey] : undefined)
  const loadSkills = useSkills((s) => s.load)
  const skillRpc = session?.opened ? session.rpc : undefined
  const refreshClaudeSkills = currentAgent === 'claude' && !running
  useEffect(() => {
    if (skillKey && skillRpc) void loadSkills(skillKey, currentCwd, skillRpc, refreshClaudeSkills)
  }, [skillKey, currentCwd, skillRpc, loadSkills, refreshClaudeSkills])

  const slashItems = useMemo<SlashItem[]>(
    () => [
      { id: 'new', kind: 'command', name: 'new', description: '开始新会话' },
      ...(running ? [{ id: 'stop', kind: 'command' as const, name: 'stop', description: '停止当前运行' }] : []),
      { id: 'refresh', kind: 'command', name: 'refresh', description: '刷新会话列表与技能' },
      ...(skillList?.items ?? []),
    ],
    [running, skillList],
  )

  const runCommand = (id: string) => {
    if (id === 'new') startDraft(currentAgent)
    else if (id === 'stop') void interrupt()
    else if (id === 'refresh') {
      void refreshThreads()
      if (skillKey && skillRpc) void loadSkills(skillKey, currentCwd, skillRpc, true)
    }
  }

  // 切换草稿后只跟踪当前输入框的读图进度。
  useLayoutEffect(() => {
    setReadingImages(attachmentReads.current.get(draftKey) ?? 0)
    // 已开始发送的新草稿保留到 RPC 完成，以便把失败的输入留给刚创建的会话。
    const pendingKey = sendingDraftKey.current
    setDrafts((previous) => {
      const entries = Object.entries(previous)
      const kept = entries.filter(([key]) => !key.startsWith('draft:') || key === draftKey || key === pendingKey)
      return kept.length === entries.length ? previous : Object.fromEntries(kept)
    })
  }, [draftKey])
  const agentStatus = session?.opening
    ? `${agentLabel(currentAgent)} 启动中…`
    : session?.openError && !session.opened
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
      <MainHeader subagents={currentThreadId && (subagents.length > 0 || supportsSubagentRequests(currentAgent)) && (
        <SubagentLauncher key={chatKey} entries={subagents} threads={session?.state.threads} rpc={session?.opened ? session.rpc : null}
          renderItem={(item, showStreamingDots) => <MessageItem key={item.id} item={item} showStreamingDots={showStreamingDots} />} />
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
                {flow.slice(firstVisible).map((entry, index) => {
                  const previous = index > 0 ? flow[firstVisible + index - 1] : undefined
                  return entry.kind === 'tools' ? (
                    <ToolGroup key={entry.key} items={entry.items} />
                  ) : entry.kind === 'work' ? (
                    <WorkGroup key={entry.key} durationMs={entry.durationMs} entries={entry.entries}
                      replyCompletedAtMs={entry.reply?.completedAtMs} onFork={canFork ? forkFromMessage : undefined} />
                  ) : entry.kind === 'stopped' ? (
                    <TurnStopped key={entry.key} durationMs={entry.durationMs} />
                  ) : (
                    <MessageItem
                      key={`${currentTargetId}:${currentAgent}:${currentThreadId}:${entry.key}`}
                      item={entry.item}
                      showStreamingDots={entry.item.id === streamingId}
                      replyTimeInSummary={previous?.kind === 'work' && previous.reply?.id === entry.item.id}
                      onFork={canFork ? forkFromMessage : undefined}
                      onEdit={(text, input) => sendAndFollow(text, { input })}
                    />
                  )
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
          contentWidthClassName={contentWidthClassName}
        />
        <AnnotationBar annotations={annotations} onRemove={removeAnnotation} contentWidthClassName={contentWidthClassName} />
      </div>
      <Composer
        key={draftKey}
        contentWidthClassName={contentWidthClassName}
        onSend={submit}
        onInterrupt={() => void interrupt()}
        running={running}
        sending={sending || preparingPi}
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
              <ContextRing tokenUsage={view?.tokenUsage} />
              <ModelPicker
                targetId={currentTargetId}
                agent={currentAgent}
                threadId={currentThreadId}
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
            {agentStatus && <span className="shrink-0 text-qn-warn">{agentStatus}</span>}
          </>
        }
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-qn-accent/60 bg-qn-bg/85 text-ui-md text-qn-text">
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
