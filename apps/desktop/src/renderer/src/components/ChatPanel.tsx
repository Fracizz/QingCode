import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type UIEvent } from 'react'
import { ArrowDown, FolderGit2, ImagePlus, Monitor, Server } from 'lucide-react'
import type { ApprovalDecision, ApprovalView, ItemView, RequestId } from '@qn/codex-client'
import { DRAFT_THREAD_ID } from '@qn/codex-client'
import { buildAnnotatedMessage, quoteBlock, type Annotation } from '../lib/annotations'
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
import type { Box } from '../lib/selection'
import { targetDotClass } from '../lib/targetStatus'
import { groupTurns } from '../lib/turnGroups'
import { useCodex, type SendMode } from '../store/codex'
import { useProjects } from '../store/projects'
import { skillsKey, useSkills } from '../store/skills'
import { useTargets } from '../store/targets'
import { useUi } from '../store/ui'
import { AgentPicker } from './AgentPicker'
import { AnnotationBar } from './AnnotationBar'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { MessageItem, ToolGroup, WorkGroup } from './MessageItem'
import { ContextRing, ModelPicker } from './ModelPicker'
import { SelectionLayer } from './SelectionLayer'
import { SendQueue } from './SendQueue'
import { MainHeader } from './shell/MainHeader'
import { WelcomePane } from './shell/WelcomePane'
import { SideChat } from './SideChat'
import { EmptyState, ErrorNote } from './ui'

export function ChatPanel({ onConnect, onAddTarget }: { onConnect: (id: string) => void; onAddTarget: () => void }) {
  const targets = useTargets((s) => s.targets)
  const targetState = useTargets((s) => s.states[s.selectedId]?.state ?? 'idle')
  const sessions = useCodex((s) => s.sessions)
  const currentTargetId = useCodex((s) => s.currentTargetId)
  const currentThreadId = useCodex((s) => s.currentThreadId)
  const currentAgent = useCodex((s) => s.currentAgent)
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
  const annotationCounter = useRef(0)
  const [pinned, setPinned] = useState(true)
  const [draft, setDraft] = useState('')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [highlights, setHighlights] = useState<Record<string, Box[]>>({})
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [readingImages, setReadingImages] = useState(0)
  const attachmentReads = useRef({ pending: 0 })
  const [skills, setSkills] = useState<SkillRef[]>([])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const imageSupport = useImageSupport(currentTargetId, currentAgent, !!currentTargetId)

  const session = currentTargetId ? sessions[sessionKey(currentTargetId, currentAgent)] : undefined
  // 草稿态没有 threadId，发送中的用户消息先放在草稿线程里，避免对话区空白。
  const view = currentThreadId
    ? session?.state.threads[currentThreadId]
    : session?.state.threads[DRAFT_THREAD_ID]
  const items: ItemView[] = useMemo(() => view?.items ?? [], [view?.items])
  const approvals: ApprovalView[] = currentThreadId && view
    ? view.pendingApprovals
    : Object.values(session?.state.threads ?? {}).flatMap((thread) => thread.pendingApprovals)
  const running = view?.status === 'running'
  const flow = useMemo(() => groupTurns(items, view?.turns, running), [items, view?.turns, running])

  // 宽度改变会让文字换行，旧的高亮坐标会指向别处。
  useLayoutEffect(() => {
    setHighlights({})
  }, [chatWidth])

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

  const submit = async (text: string, mode: SendMode, delegate: boolean): Promise<boolean> => {
    const message = buildAnnotatedMessage(annotations, text)
    const input = buildUserInput(message, attachments, skills)
    if (input.length === 0) return false
    if (!(await send(message, { input, mode, delegate }))) return false
    setDraft((current) => current === text ? '' : current)
    for (const annotation of annotations) removeAnnotation(annotation.id)
    setAttachments((current) => current.filter((item) => !attachments.some((sent) => sent.id === item.id)))
    setSkills((current) => current.filter((item) => !skills.includes(item)))
    return true
  }

  const notify = (message: string) => useCodex.setState({ notice: message })

  const patchAttachment = (id: string, patch: Partial<Attachment>) =>
    setAttachments((prev) => prev.map((item) => (item.id === id ? ({ ...item, ...patch } as Attachment) : item)))

  /** 图片读成 data URL 随消息发送；其他文件本机目标直接引用路径，远端目标先上传到目标机。 */
  const addFiles = (files: File[]) => {
    if (!currentTargetId) return
    const targetId = currentTargetId
    const reads = attachmentReads.current
    const { accepted, rejected } = screenFiles(files, {
      existingImages: attachments.filter((item) => item.kind === 'image').length + reads.pending,
      imagesAllowed: imageSupport.allowed,
      unsupportedReason: imageSupport.reason ?? undefined,
    })
    if (rejected.length > 0) {
      const detail = rejected.map((item) => `${item.name}：${item.reason}`).join('；')
      notify(`未添加 ${rejected.length} 张图片（${detail}）`)
    }
    if (accepted.length === 0) return
    const room = MAX_ATTACHMENTS - attachments.length - reads.pending
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
        reads.pending += 1
        setReadingImages(reads.pending)
        void readImage(file)
          .then(({ dataUrl, size }) => {
            if (attachmentReads.current !== reads) return
            setAttachments((prev) => [...prev, { id, kind: 'image', name: file.name || '粘贴的图片', size, dataUrl }])
          })
          .catch((err: unknown) => {
            if (attachmentReads.current === reads) {
              notify((file.name || '图片') + '：' + (err instanceof Error ? err.message : '读取失败'))
            }
          })
          .finally(() => {
            reads.pending -= 1
            if (attachmentReads.current === reads) setReadingImages(reads.pending)
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
    setDraft(quoteBlock(markdown))
  }
  // 进行中的轮次不能分叉（Codex 会拒绝），运行期间先不提供入口。
  const canFork = !(currentAgent === 'codex' && running)

  const target = targets.find((item) => item.id === currentTargetId)
  const project = projects.find((item) => item.id === selectedProjectId)
  const TargetIcon = target && target.kind !== 'local' ? Server : Monitor
  const isDraft = !currentThreadId

  const skillList = useSkills((s) =>
    currentTargetId ? s.lists[skillsKey(currentTargetId, currentAgent, currentCwd)] : undefined,
  )
  const loadSkills = useSkills((s) => s.load)
  const sessionOpened = session?.opened === true
  useEffect(() => {
    if (currentTargetId && sessionOpened && session) void loadSkills(currentTargetId, currentAgent, currentCwd, session.rpc)
  }, [currentTargetId, currentAgent, currentCwd, sessionOpened, session, loadSkills])

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
      if (currentTargetId && session) void loadSkills(currentTargetId, currentAgent, currentCwd, session.rpc, true)
    }
  }

  // 切换目标或 Agent 后，旧目标上传的附件路径不再有效。
  useLayoutEffect(() => {
    attachmentReads.current = { pending: 0 }
    setReadingImages(0)
    setAttachments([])
    setSkills([])
  }, [currentTargetId, currentAgent])
  const agentStatus = session?.opening
    ? `${agentLabel(currentAgent)} 启动中…`
    : session?.openError && !session.opened
      ? `${agentLabel(currentAgent)} 不可用`
      : null

  return (
    <main
      className="qn-enter relative flex min-w-0 flex-1 flex-col bg-qn-bg"
      style={{ ['--qn-enter-order' as string]: 2 }}
      onDragEnter={onDragEnter}
      onDragOver={(event) => {
        if (hasFiles(event)) event.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <MainHeader />

      <div className="relative min-h-0 flex-1">
        <SelectionLayer
          containerRef={scrollRef}
          layoutKey={chatWidth}
          className={`qn-scroll h-full overflow-y-auto px-6 pb-6 pt-2 [scrollbar-gutter:stable_both-edges]${pinned ? ' [overflow-anchor:none]' : ''}`}
          onScroll={onScroll}
          highlights={Object.values(highlights).flat()}
          onAdd={addAnnotation}
          onSide={(quote) => void openSideChat(quote)}
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
            {view?.error && (
              <div className="mb-3">
                <ErrorNote message={`Turn 失败：${view.error}`} />
              </div>
            )}

            {isDraft && items.length === 0 && approvals.length === 0 ? (
              <div className="flex flex-1 flex-col">
                <WelcomePane onConnect={onConnect} onAddTarget={onAddTarget} />
              </div>
            ) : items.length === 0 && approvals.length === 0 ? (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState>会话暂无消息，发送一条开始对话。</EmptyState>
              </div>
            ) : (
              <div className="space-y-4 pt-4">
                {flow.map((entry) =>
                  entry.kind === 'tools' ? (
                    <ToolGroup key={entry.key} items={entry.items} />
                  ) : entry.kind === 'work' ? (
                    <WorkGroup key={entry.key} durationMs={entry.durationMs} entries={entry.entries} onFork={canFork ? forkFromMessage : undefined} />
                  ) : (
                    <MessageItem
                      key={`${currentTargetId}:${currentAgent}:${currentThreadId}:${entry.key}`}
                      item={entry.item}
                      onFork={canFork ? forkFromMessage : undefined}
                      onEdit={(text, input) => send(text, { input })}
                    />
                  ),
                )}
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={String(approval.requestId)}
                    approval={approval}
                    onDecide={(decision: ApprovalDecision) => respondApproval(approval.requestId as RequestId, decision)}
                  />
                ))}
              </div>
            )}
          </div>
        </SelectionLayer>
        {!pinned && (
          <button
            type="button"
            className="qn-surface-float absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] hover:bg-qn-hover"
            onClick={scrollToBottom}
          >
            <ArrowDown size={14} /> 回到底部
          </button>
        )}
      </div>

      <SendQueue
        targetId={currentTargetId}
        agent={currentAgent}
        threadId={currentThreadId}
        running={running}
        contentWidthClassName={contentWidthClassName}
      />
      <AnnotationBar annotations={annotations} onRemove={removeAnnotation} />
      <Composer
        contentWidthClassName={contentWidthClassName}
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
        leading={<AgentPicker targetId={currentTargetId} agent={currentAgent} locked={!isDraft} />}
        trailing={
          currentTargetId && (
            <>
              <ContextRing tokenUsage={view?.tokenUsage} />
              <ModelPicker targetId={currentTargetId} agent={currentAgent} />
            </>
          )
        }
        footer={
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${targetDotClass[targetState]}`} />
              <TargetIcon size={13} className="shrink-0" />
              <span className="truncate">{target?.name ?? '未选择目标'}</span>
            </span>
            {project && (
              <span className="flex min-w-0 items-center gap-1.5" title={project.path}>
                <FolderGit2 size={13} className="shrink-0" />
                <span className="truncate font-mono text-[11.5px]">{project.path}</span>
              </span>
            )}
            {agentStatus && <span className="shrink-0 text-qn-warn">{agentStatus}</span>}
          </>
        }
      />
      <SideChat />
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-qn-accent/60 bg-qn-bg/85 text-[14px] text-qn-text">
          <ImagePlus size={28} className="text-qn-accent" />
          松开以添加图片或文件
          <span className="text-[12px] text-qn-muted">
            图片随消息发送；其他文件{target && target.kind !== 'local' ? '会先上传到目标机' : '按本机路径引用'}
          </span>
        </div>
      )}
    </main>
  )
}
