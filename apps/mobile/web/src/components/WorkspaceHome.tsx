import { sessionStatusLabels, type SessionStatus } from '@qn/codex-client'
import { ChevronDown, ChevronRight, Ellipsis, Folder, MessageSquareText, Monitor, RotateCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { sessionKey } from '../agents'
import { useApp } from '../store'
import type { Project, Target } from '../types'
import {
  filterProjects,
  groupWorkspaceThreads,
  isWorkspaceTabDoubleTap,
  openWorkspaceThread,
  recentThreadStatus,
  threadPreviewLine,
  displayPath,
  showWorkspaceProject,
  useWorkspace,
  visibleWorkspaceThreads,
  workspaceThreadKey,
  type WorkspaceTab,
  type WorkspaceThread,
} from '../workspace'
import { formatTime, friendlyError } from '../state'
import { ARCHIVE_ACTION_WIDTH, threadSwipeAxis, threadSwipeOffset } from '../threadSwipe'
import { AgentTag, Badge, Button, Empty, Loading, LoadingIcon, Note } from './ui'
import { NewSessionButton } from './NewSessionButton'
import { ProjectTools } from './ProjectTools'

const tabs: { id: WorkspaceTab; title: string }[] = [
  { id: 'sessions', title: '会话' },
  { id: 'projects', title: '项目' },
  { id: 'connections', title: '连接' },
]

const statusTone: Record<SessionStatus, 'muted' | 'accent' | 'warn' | 'danger'> = {
  idle: 'muted', running: 'accent', pending: 'warn', input: 'warn', completed: 'muted',
  failed: 'danger', interrupted: 'muted', unread: 'accent',
}
const emptyProjects: Project[] = []
const emptyThreads: WorkspaceThread[] = []
const THREAD_PREVIEW_LIMIT = 5

const workspaceIcons = {
  sessions: MessageSquareText,
  projects: Folder,
  connections: Monitor,
  search: Search,
  refresh: RotateCw,
  more: Ellipsis,
} as const

export function WorkspaceIcon({ name }: { name: WorkspaceTab | 'search' | 'refresh' | 'more' }) {
  const Icon = workspaceIcons[name]
  return <Icon size={21} strokeWidth={1.75} aria-hidden />
}

export function WorkspaceNav({ onScrollTop }: { onScrollTop: () => void }) {
  const workspaceTab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const page = useApp((s) => s.page)
  const tab = page === 'connections' ? 'connections' : workspaceTab
  const lastTap = useRef<Parameters<typeof isWorkspaceTabDoubleTap>[0]>(null)
  function navigate(id: WorkspaceTab, pointerClick: boolean) {
    const tap = pointerClick ? { tab: id, at: performance.now() } : null
    const doubleTap = tap !== null && isWorkspaceTabDoubleTap(lastTap.current, tap)
    lastTap.current = doubleTap ? null : tap
    if (id === tab) {
      if (doubleTap) onScrollTop()
      return
    }
    setTab(id)
    if (page === 'connections') useApp.setState({ page: 'workspace' })
  }
  return (
    <nav className="qn-nav" aria-label="工作台">
      {tabs.map(({ id, title }) => (
        <button type="button" key={id} className="qn-nav-button" aria-current={id === tab ? 'page' : undefined}
          onClick={(event) => navigate(id, event.detail > 0)}>
          <span><WorkspaceIcon name={id} /></span>
          {title}
        </button>
      ))}
    </nav>
  )
}

export function WorkspaceSearch({
  label, query, onChange,
}: {
  label: string
  query: string
  onChange: (value: string) => void
}) {
  return (
    <div className="qn-search">
      <WorkspaceIcon name="search" />
      <input type="search" value={query} aria-label={label} placeholder={label} onChange={(event) => onChange(event.target.value)} />
      {query && <button type="button" aria-label="清空搜索" onClick={() => onChange('')}><X size={17} /></button>}
    </div>
  )
}

export function ProjectOrigin({ target }: { target?: Target }) {
  const name = target?.kind === 'ssh' ? `远端 · ${target.name}` : target?.name ?? '目标已移除'
  return <span className="qn-origin" title={target?.kind === 'ssh' ? target.host : undefined}>{name}</span>
}

export function WorkspaceThreadRow({
  thread, onOpen, selected = false,
}: {
  thread: WorkspaceThread
  onOpen: () => void
  selected?: boolean
}) {
  const view = useApp((s) => s.sessions[sessionKey(thread.targetId, thread.agent)]?.state.threads[thread.id])
  const desktopId = useApp((s) => s.activeId)
  const opening = useApp(({ openingThread }) => openingThread?.desktopId === desktopId
    && openingThread.targetId === thread.targetId && openingThread.agent === thread.agent && openingThread.threadId === thread.id)
  const archiveConversation = useApp((s) => s.archiveConversation)
  const unread = useWorkspace((s) => desktopId ? s.threads[desktopId]?.find((item) =>
    item.id === thread.id && item.agent === thread.agent && item.targetId === thread.targetId && item.projectId === thread.projectId,
  )?.unread : undefined)
  const status = recentThreadStatus({ ...thread, unread: unread ?? thread.unread }, view)
  const preview = threadPreviewLine(thread.title, thread.preview)
  const row = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ id: number; x: number; y: number; axis: ReturnType<typeof threadSwipeAxis> } | null>(null)
  const suppressClick = useRef(false)
  const touchTap = useRef<number | undefined>(undefined)
  const [revealedDesktop, setRevealedDesktop] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const revealed = desktopId !== null && revealedDesktop === desktopId
  const offset = dragOffset ?? (revealed ? -ARCHIVE_ACTION_WIDTH : 0)

  useEffect(() => {
    if (!revealed) return
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !row.current?.contains(event.target)) setRevealedDesktop(null)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    return () => document.removeEventListener('pointerdown', closeOutside, true)
  }, [revealed])

  function startSwipe(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0) return
    window.clearTimeout(touchTap.current)
    suppressClick.current = false
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null }
  }

  function moveSwipe(event: PointerEvent<HTMLButtonElement>) {
    const start = gesture.current
    if (!start || start.id !== event.pointerId) return
    const dx = event.clientX - start.x
    if (!start.axis) {
      start.axis = threadSwipeAxis(dx, event.clientY - start.y)
      if (start.axis) suppressClick.current = true
      if (start.axis === 'horizontal' && event.pointerType === 'mouse') {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
    }
    if (start.axis === 'horizontal') setDragOffset(threadSwipeOffset(revealed, dx))
  }

  function finishSwipe(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const start = gesture.current
    if (!start || start.id !== event.pointerId) return
    gesture.current = null
    setDragOffset(null)
    if (cancelled) {
      suppressClick.current = true
      return
    }
    const dx = event.clientX - start.x
    const axis = start.axis ?? threadSwipeAxis(dx, event.clientY - start.y)
    if (axis === 'horizontal') {
      const end = threadSwipeOffset(revealed, dx)
      setRevealedDesktop(end <= -ARCHIVE_ACTION_WIDTH / 2 ? desktopId : null)
    }
    if (axis) {
      suppressClick.current = true
    } else if (event.pointerType === 'touch') {
      const { currentTarget: button, clientX, clientY } = event
      // 横滑后的首次轻点可能没有合成 click，留出原生点击的派发时间再补一次。
      touchTap.current = window.setTimeout(() => {
        if (!button.isConnected || !button.contains(document.elementFromPoint(clientX, clientY))) return
        suppressClick.current = true
        activate()
      }, 48)
    }
  }

  function activate() {
    if (revealed) setRevealedDesktop(null)
    else if (!opening) onOpen()
  }

  async function archive() {
    if (archiving) return
    setArchiving(true)
    setArchiveError(null)
    try {
      await archiveConversation(thread.targetId, thread)
    } catch (err) {
      setArchiveError(`归档失败。${friendlyError(err, '请重试')}`)
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="qn-thread-row" ref={row} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setRevealedDesktop(null)
    }}>
      <div className="qn-thread-swipe">
        <button type="button" className="qn-row qn-list-row qn-thread-content" aria-current={selected ? 'true' : undefined}
          aria-busy={opening}
          data-dragging={dragOffset !== null} style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
          onPointerDown={startSwipe} onPointerMove={moveSwipe} onPointerUp={finishSwipe}
          onPointerCancel={(event) => finishSwipe(event, true)} onLostPointerCapture={(event) => {
            if (event.target === event.currentTarget) finishSwipe(event, true)
          }}
          onClick={(event) => {
            window.clearTimeout(touchTap.current)
            if (event.detail !== 0 && suppressClick.current) {
              suppressClick.current = false
              return
            }
            activate()
          }}>
          <span className="qn-row-copy">
            <span className="qn-list-primary">
              <span className="truncate">{thread.title}</span>
              <AgentTag agent={thread.agent} />
            </span>
            {preview && <span className="qn-subtitle block">{preview}</span>}
            <span className="qn-subtitle block">{formatTime(thread.updatedAt)}</span>
          </span>
          {opening ? (
            <span className="qn-row-status text-qn-accent" role="status"><LoadingIcon />打开中…</span>
          ) : status === 'running' ? (
            <span className="qn-row-status text-qn-accent"><LoadingIcon />{sessionStatusLabels[status]}</span>
          ) : <Badge tone={statusTone[status]}>{sessionStatusLabels[status]}</Badge>}
          <ChevronRight size={16} className="shrink-0 text-qn-dim" aria-hidden />
        </button>
        <button type="button" className="qn-thread-archive" style={{ width: ARCHIVE_ACTION_WIDTH }}
          aria-label={`归档 ${thread.title}${thread.agent === 'codex' ? '' : '（仅此手机）'}`}
          aria-disabled={archiving} onFocus={() => setRevealedDesktop(desktopId)} onClick={() => void archive()}>
          {archiving ? '归档中…' : '归档'}
          {thread.agent !== 'codex' && !archiving && <small>仅此手机</small>}
        </button>
      </div>
      {archiveError && <p className="qn-thread-archive-error" role="alert">{archiveError}</p>}
    </div>
  )
}

export function WorkspaceProjectRow({ project, target, onOpen }: {
  project: Project
  target?: Target
  onOpen: () => void
}) {
  return (
    <div className="qn-row qn-list-row">
      <button type="button" className="qn-row-trigger" onClick={onOpen} disabled={!target}>
        <span className="qn-row-copy">
          <span className="qn-list-primary">{project.name}</span>
          <span className="qn-subtitle qn-mono block">{displayPath(project.path)}</span>
        </span>
      </button>
      {target && <NewSessionButton project={project} iconOnly className="qn-header-icon" />}
      <ProjectTools project={project} />
    </div>
  )
}

function WorkspaceThreadList({ threads, projectName, searching, onOpen }: {
  threads: WorkspaceThread[]
  projectName: string
  searching: boolean
  onOpen: (thread: WorkspaceThread) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const olderThreadsId = useId()
  const preview = searching ? threads : threads.slice(0, THREAD_PREVIEW_LIMIT)
  const remaining = threads.length - preview.length
  const label = expanded ? '收起' : `显示更多（${remaining} 条）`
  const renderRow = (thread: WorkspaceThread) => (
    <WorkspaceThreadRow key={workspaceThreadKey(thread)} thread={thread} onOpen={() => onOpen(thread)} />
  )

  return (
    <div className="qn-list-group">
      {preview.map(renderRow)}
      {remaining > 0 && (
        <>
          <button type="button" className="qn-session-more qn-pressable" aria-label={`${label} · ${projectName}`}
            aria-expanded={expanded} aria-controls={olderThreadsId} onClick={() => setExpanded((value) => !value)}>
            {label}<ChevronDown size={16} aria-hidden />
          </button>
          <div id={olderThreadsId} className="qn-session-overflow" hidden={!expanded}>
            {expanded && threads.slice(THREAD_PREVIEW_LIMIT).map(renderRow)}
          </div>
        </>
      )}
    </div>
  )
}

export function WorkspaceHome() {
  const tab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const desktopId = useApp((s) => s.activeId)
  const archived = useApp((s) => s.archivedThreads)
  const connected = useApp((s) => s.eventsConnected)
  const repairReason = useApp((s) => s.activeId ? s.needsRepair[s.activeId] : undefined)
  const beginRepair = useApp((s) => s.beginRepair)
  const notice = useApp((s) => s.notice)
  const error = useApp((s) => s.error)
  const clearError = useApp((s) => s.clearError)
  const targets = useApp((s) => s.targets)
  const loadTargets = useApp((s) => s.loadTargets)
  const loadProjects = useWorkspace((s) => s.loadProjects)
  const projectList = useWorkspace((s) => desktopId ? s.projects[desktopId] : undefined)
  const threadList = useWorkspace((s) => desktopId ? s.threads[desktopId] : undefined) ?? emptyThreads
  const [query, setQuery] = useState('')
  const projects = projectList?.items ?? emptyProjects
  const matchedProjects = useMemo(() => filterProjects(projects, targets, query), [projects, targets, query])
  const groups = useMemo(() => groupWorkspaceThreads(visibleWorkspaceThreads(threadList, desktopId, archived), projects, query),
    [threadList, desktopId, archived, projects, query])

  const refresh = useCallback(() => {
    if (desktopId) void Promise.all([loadTargets(), loadProjects(desktopId)])
  }, [desktopId, loadTargets, loadProjects])

  useEffect(refresh, [connected, tab, refresh])

  const isSessions = tab === 'sessions'
  const searching = query.trim().length > 0
  const showTargets = () => {
    useApp.getState().cancelPendingNavigation()
    useApp.setState({ page: 'targets' })
  }
  return (
    <main className="qn-body qn-scroll qn-workspace qn-workspace-home qn-rise" aria-label={isSessions ? '会话' : '项目'}>
      {repairReason && desktopId && (
        <Note message={repairReason === 'fingerprint' ? '电脑证书已变化，请核对后重新配对。' : '电脑已撤销此设备的授权。'}
          tone="error" actionLabel="重新配对" onAction={() => beginRepair(desktopId)} />
      )}
      {notice && <Note message={notice} tone="warn" />}
      {error && <Note message={error} tone="error" onClose={clearError} />}
      {projectList?.error && !repairReason && (
        <Note message="读取项目失败，请检查电脑和网络。" tone="error" actionLabel="重试" onAction={refresh} />
      )}
      {projectList?.loading && projects.length === 0 ? <Loading text="正在读取项目…" /> : (
        <>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <WorkspaceSearch label={isSessions ? '搜索会话或项目' : '搜索项目、主机或路径'} query={query} onChange={setQuery} />
            </div>
            {isSessions && <NewSessionButton projects={projects} iconOnly primary className="qn-header-icon" />}
          </div>
          {isSessions ? (
            groups.length ? groups.map(({ project, threads }) => (
              <section key={JSON.stringify([desktopId, project.targetId, project.id])} className="qn-workspace-group">
                <div className="qn-group-heading">
                  <h2 className="truncate">{project.name}</h2>
                  <ProjectOrigin target={targets.find((item) => item.id === project.targetId)} />
                  {targets.some((item) => item.id === project.targetId) && <NewSessionButton project={project} iconOnly className="qn-header-icon" />}
                  <ProjectTools project={project} />
                  <Button variant="ghost" className="qn-group-action" onClick={() => void showWorkspaceProject(project)}
                    aria-label={`进入 ${project.name} 项目的会话`}><ChevronRight size={18} /></Button>
                </div>
                <WorkspaceThreadList threads={threads} projectName={project.name} searching={searching}
                  onOpen={(thread) => void openWorkspaceThread(thread, project)} />
              </section>
            )) : (
              <Empty>
                <p>{query ? '没有匹配的会话。' : '还没有最近访问的会话。'}</p>
                <button type="button" className="qn-dashed-action qn-pressable" onClick={() => { setQuery(''); setTab('projects') }}>选择项目</button>
              </Empty>
            )
          ) : (
            matchedProjects.length ? targets.map((target) => {
              const rows = matchedProjects.filter((item) => item.targetId === target.id)
              if (!rows.length) return null
              return (
                <section key={target.id} className="qn-workspace-group">
                  <div className="qn-group-heading">
                    <h2><ProjectOrigin target={target} /></h2>
                  </div>
                  <div className="qn-list-group">
                    {rows.map((project) => <WorkspaceProjectRow key={project.id} project={project} target={target}
                      onOpen={() => void showWorkspaceProject(project)} />)}
                  </div>
                </section>
              )
            }) : <Empty>{query ? '没有匹配的项目。' : '在目标中选择或添加项目。'}</Empty>
          )}
          {(!isSessions || groups.length > 0) && (
            <Button className="mt-4 w-full" onClick={isSessions ? () => { setQuery(''); setTab('projects') } : showTargets}>
              {isSessions ? '从其他项目打开会话' : '管理目标与项目'}
            </Button>
          )}
        </>
      )}
    </main>
  )
}
