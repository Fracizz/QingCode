import { ChevronRight, Ellipsis, Folder, LoaderCircle, MessageSquareText, Monitor, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { sessionKey } from '../agents'
import { useApp } from '../store'
import type { Project, Target } from '../types'
import {
  filterProjects,
  groupWorkspaceThreads,
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
import { AgentTag, Badge, Button, Empty, Loading, Note, StatusDot } from './ui'
import { ProjectTools } from './ProjectTools'

const tabs: { id: WorkspaceTab; title: string }[] = [
  { id: 'sessions', title: '会话' },
  { id: 'projects', title: '项目' },
  { id: 'connections', title: '连接' },
]
const emptyProjects: Project[] = []
const emptyThreads: WorkspaceThread[] = []

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

export function WorkspaceNav() {
  const workspaceTab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const page = useApp((s) => s.page)
  const tab = page === 'connections' ? 'connections' : workspaceTab
  function navigate(id: WorkspaceTab) {
    setTab(id)
    if (page === 'connections') useApp.setState({ page: 'workspace' })
  }
  return (
    <nav className="qn-nav" aria-label="工作台">
      {tabs.map(({ id, title }) => (
        <button type="button" key={id} className="qn-nav-button" aria-current={id === tab ? 'page' : undefined}
          onClick={() => navigate(id)}>
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
  const archiveConversation = useApp((s) => s.archiveConversation)
  const status = recentThreadStatus(thread, view)
  const preview = threadPreviewLine(thread.title, thread.preview)
  const row = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ id: number; x: number; y: number; axis: ReturnType<typeof threadSwipeAxis> } | null>(null)
  const suppressClick = useRef(false)
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
    if (cancelled || start.axis !== 'horizontal') return
    const end = threadSwipeOffset(revealed, event.clientX - start.x)
    setRevealedDesktop(end <= -ARCHIVE_ACTION_WIDTH / 2 ? desktopId : null)
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
          data-dragging={dragOffset !== null} style={{ transform: offset ? `translateX(${offset}px)` : undefined }}
          onPointerDown={startSwipe} onPointerMove={moveSwipe} onPointerUp={finishSwipe}
          onPointerCancel={(event) => finishSwipe(event, true)} onLostPointerCapture={(event) => {
            if (event.target === event.currentTarget) finishSwipe(event, true)
          }}
          onClick={(event) => {
            if (event.detail !== 0 && suppressClick.current) {
              suppressClick.current = false
              return
            }
            if (revealed) setRevealedDesktop(null)
            else onOpen()
          }}>
          <span className="qn-row-copy">
            <span className="qn-list-primary">
              <span className="truncate">{thread.title}</span>
              <AgentTag agent={thread.agent} />
            </span>
            {preview && <span className="qn-subtitle block">{preview}</span>}
            <span className="qn-subtitle block">{formatTime(thread.updatedAt)}</span>
          </span>
          {status === 'pending' && <Badge tone="warn">待审批</Badge>}
          {status === 'running' && (
            <span className="qn-row-status text-qn-accent"><LoaderCircle size={14} className="qn-spin" aria-hidden />运行中</span>
          )}
          {status === 'unread' && <span className="qn-row-status text-qn-muted"><span className="qn-unread-dot" aria-hidden />有新结果</span>}
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
      <ProjectTools project={project} />
    </div>
  )
}

export function WorkspaceHome() {
  const tab = useWorkspace((s) => s.tab)
  const setTab = useWorkspace((s) => s.setTab)
  const desktopId = useApp((s) => s.activeId)
  const archived = useApp((s) => s.archivedThreads)
  const connection = useApp((s) => s.connections.find((item) => item.id === s.activeId))
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
  const [opening, setOpening] = useState(false)
  const projects = projectList?.items ?? emptyProjects
  const matchedProjects = useMemo(() => filterProjects(projects, targets, query), [projects, targets, query])
  const groups = useMemo(() => groupWorkspaceThreads(visibleWorkspaceThreads(threadList, desktopId, archived), projects, query),
    [threadList, desktopId, archived, projects, query])

  useEffect(() => {
    if (desktopId) void loadProjects(desktopId)
  }, [desktopId, connected, tab, loadProjects])

  const open = async (action: () => Promise<unknown>) => {
    if (opening) return
    setOpening(true)
    try {
      await action()
    } finally {
      setOpening(false)
    }
  }
  const isSessions = tab === 'sessions'
  const showTargets = () => useApp.setState({ page: 'targets' })
  const refresh = () => {
    if (!desktopId) return
    void Promise.all([loadTargets(), loadProjects(desktopId)])
  }

  return (
    <main className="qn-body qn-scroll qn-workspace qn-rise" aria-busy={opening}>
      <header className="qn-workspace-title" data-connected={connected}>
        <div className="qn-workspace-context">
          <button type="button" className="qn-inline-action" onClick={() => setTab('connections')}>
            <StatusDot tone={connected ? 'ok' : repairReason ? 'danger' : 'muted'} />
            <span className="truncate">{connection?.name ?? '未连接电脑'} · {connected ? '在线' : repairReason ? '待配对' : '离线'}</span>
            <ChevronRight size={14} aria-hidden />
          </button>
          <Button variant="ghost" onClick={refresh} disabled={projectList?.loading} aria-label="刷新项目">
            <WorkspaceIcon name="refresh" />
          </Button>
        </div>
        <h1>{isSessions ? '会话' : '项目'}</h1>
      </header>
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
          <WorkspaceSearch label={isSessions ? '搜索会话或项目' : '搜索项目、主机或路径'} query={query} onChange={setQuery} />
          {isSessions ? (
            groups.length ? groups.map(({ project, threads }) => (
              <section key={project.id} className="qn-workspace-group">
                <div className="qn-group-heading">
                  <h2 className="truncate">{project.name}</h2>
                  <ProjectOrigin target={targets.find((item) => item.id === project.targetId)} />
                  <ProjectTools project={project} />
                  <Button variant="ghost" className="qn-group-action" onClick={() => void open(() => showWorkspaceProject(project.targetId, project.id))}
                    aria-label={`进入 ${project.name} 项目的会话`}><ChevronRight size={18} /></Button>
                </div>
                <div className="qn-list-group">
                  {threads.map((thread) => <WorkspaceThreadRow key={workspaceThreadKey(thread)} thread={thread}
                    onOpen={() => void open(() => openWorkspaceThread(thread))} />)}
                </div>
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
                      onOpen={() => void open(() => showWorkspaceProject(project.targetId, project.id))} />)}
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
