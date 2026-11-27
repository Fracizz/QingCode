import { sessionStatusLabels, type SessionStatus, t, translateMessage } from '@qn/codex-client'
import { Archive, Check, ChevronDown, ChevronRight, Ellipsis, Folder, MessageCircleMore, Monitor, Pencil, Pin, PinOff, RotateCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import { sessionKey } from '../agents'
import { pageName } from '../names'
import { useApp } from '../store'
import type { Project, Target } from '../types'
import {
  filterProjects,
  changeThreadPreference,
  groupWorkspaceThreads,
  isWorkspaceTabDoubleTap,
  openWorkspaceThread,
  orderWorkspaceProjects,
  placeWorkspaceProject,
  renameCachedThread,
  recentThreadStatus,
  threadPreviewLine,
  displayPath,
  showWorkspaceProject,
  threadPreferenceKey,
  useWorkspace,
  useWorkspacePreferences,
  visibleWorkspaceThreads,
  workspaceThreadKey,
  type WorkspaceTab,
  type WorkspaceThread,
} from '../workspace'
import { formatTime, friendlyError } from '../state'
import { ARCHIVE_ACTION_WIDTH, threadSwipeAxis, threadSwipeOffset } from '../threadSwipe'
import { AgentTag, Badge, Button, Dialog, Empty, Loading, LoadingIcon, Note, SheetAction } from './ui'
import { NewSessionButton } from './NewSessionButton'
import { ProjectTools } from './ProjectTools'
import { PullToRefresh } from './PullToRefresh'
import { SortableList } from './SortableList'

const tabs: { id: WorkspaceTab; title: string }[] = [
  { id: 'sessions', title: pageName('sessions') },
  { id: 'projects', title: pageName('projects') },
  { id: 'connections', title: pageName('connections') },
]

const statusTone: Record<SessionStatus, 'muted' | 'accent' | 'warn' | 'danger'> = {
  idle: 'muted', running: 'accent', pending: 'warn', input: 'warn', completed: 'muted',
  failed: 'danger', interrupted: 'muted', unread: 'accent',
}
const QUIET_STATUS = new Set<SessionStatus>(['idle', 'completed', 'interrupted'])
const emptyProjects: Project[] = []
const emptyThreads: WorkspaceThread[] = []
const THREAD_PREVIEW_LIMIT = 5

const workspaceIcons = {
  sessions: MessageCircleMore,
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
    <nav className="qn-nav" aria-label={t('工作台')}>
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
      {query && <button type="button" aria-label={t('清空搜索')} onClick={() => onChange('')}><X size={17} /></button>}
    </div>
  )
}

export function ProjectOrigin({ target }: { target?: Target }) {
  const name = target?.kind === 'ssh' ? t('远端 · {name}', { name: target.name })
    : target?.kind === 'direct' ? t('直连 · {name}', { name: target.name }) : target?.name ?? t('目标已移除')
  return <span className="qn-origin" title={target?.kind === 'local' ? undefined : target?.host}>{name}</span>
}

export function WorkspaceThreadRow({
  thread, onOpen, selected = false,
}: {
  thread: WorkspaceThread
  onOpen: () => void
  selected?: boolean
}) {
  const desktopId = useApp((s) => s.activeId)
  const opening = useApp(({ openingThread }) => openingThread?.desktopId === desktopId
    && openingThread.targetId === thread.targetId && openingThread.agent === thread.agent && openingThread.threadId === thread.id)
  const archiveConversation = useApp((s) => s.archiveConversation)
  const renameConversation = useApp((s) => s.renameConversation)
  const preference = useWorkspacePreferences()?.threads[threadPreferenceKey(thread.targetId, thread.agent, thread.id)]
  const unread = useWorkspace((s) => desktopId ? s.threads[desktopId]?.find((item) =>
    item.id === thread.id && item.agent === thread.agent && item.targetId === thread.targetId && item.projectId === thread.projectId,
  )?.unread : undefined)
  // 只订阅派生出的状态字符串：订阅整个线程视图时，流式增量每次都会让这一行重渲染。
  const status = useApp((s) => recentThreadStatus({ ...thread, unread: unread ?? thread.unread },
    s.sessions[sessionKey(thread.targetId, thread.agent)]?.state.threads[thread.id]))
  const preview = threadPreviewLine(thread.title, thread.preview)
  const row = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ id: number; x: number; y: number; axis: ReturnType<typeof threadSwipeAxis> } | null>(null)
  const suppressClick = useRef(false)
  const touchTap = useRef<number | undefined>(undefined)
  const archiveTouch = useRef<{ id: number; x: number; y: number; cancelled: boolean } | null>(null)
  const archivePending = useRef(false)
  const [revealedDesktop, setRevealedDesktop] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'actions' | 'rename' | null>(null)
  const [name, setName] = useState(thread.title)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
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

  function startArchiveTouch(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0) return
    archiveTouch.current = event.pointerType === 'touch'
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, cancelled: false }
      : null
    // WebView 的触摸轻点可能没有合成 click，直接处理手指抬起。
    if (archiveTouch.current) event.preventDefault()
  }

  function trackArchiveTouch(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const touch = archiveTouch.current
    if (!touch || touch.id !== event.pointerId || touch.cancelled) return
    if (cancelled || threadSwipeAxis(event.clientX - touch.x, event.clientY - touch.y)) {
      touch.cancelled = true
    }
  }

  function finishArchiveTouch(event: PointerEvent<HTMLButtonElement>) {
    trackArchiveTouch(event)
    const touch = archiveTouch.current
    if (!touch || touch.id !== event.pointerId || touch.cancelled) return
    touch.cancelled = true
    if (revealed && event.currentTarget.contains(document.elementFromPoint(event.clientX, event.clientY))) {
      void archive()
    }
  }

  async function archive() {
    if (archivePending.current) return
    archivePending.current = true
    setArchiving(true)
    setArchiveError(null)
    try {
      await archiveConversation(thread.targetId, thread)
    } catch (err) {
      setArchiveError(t('归档失败。{message}', { message: translateMessage(friendlyError(err, t('请重试'))) }))
    } finally {
      archivePending.current = false
      setArchiving(false)
    }
  }

  async function rename() {
    const title = name.trim()
    if (!desktopId || !title || renaming) return
    setRenaming(true)
    setRenameError(null)
    try {
      if (thread.agent === 'codex') {
        const connection = useApp.getState().connections.find((item) => item.id === desktopId)
        await renameConversation(thread.targetId, thread.id, title)
        if (connection && useApp.getState().connections.some((item) => item.id === desktopId && item.fp === connection.fp)) {
          renameCachedThread(desktopId, thread, title)
        }
      } else {
        changeThreadPreference(desktopId, thread, { title })
      }
      setMenu(null)
    } catch (err) {
      setRenameError(friendlyError(err, t('重命名失败')))
    } finally {
      setRenaming(false)
    }
  }

  return (
    <div className="qn-thread-row" ref={row} onBlur={(event) => {
      // 触摸按钮时焦点可能暂时为空，点击行外由 pointerdown 处理。
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setRevealedDesktop(null)
    }}>
      <div className="flex items-center">
        <div className="qn-thread-swipe min-w-0 flex-1">
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
              <span className="qn-list-primary qn-thread-title">
                <span className="truncate">{thread.title}</span>
                {preference?.pinned && <Pin size={13} className="inline shrink-0 text-qn-muted" aria-label={t('已置顶')} />}
              </span>
              {preview && <span className="qn-subtitle block">{preview}</span>}
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <AgentTag agent={thread.agent} />
                <span className="qn-subtitle">{formatTime(thread.updatedAt)}</span>
              </span>
            </span>
            {/* 空闲、已完成、已中断是常态，不再逐行挂徽标；只标出需要注意的状态。 */}
            {opening ? (
              <span className="qn-row-status text-qn-accent" role="status"><LoadingIcon />{t('打开中…')}</span>
            ) : status === 'running' ? (
              <span className="qn-row-status text-qn-accent"><LoadingIcon role="img" aria-hidden />{sessionStatusLabels[status]}</span>
            ) : status === 'unread' ? (
              <span className="qn-unread-dot shrink-0" role="img" aria-label={sessionStatusLabels[status]} />
            ) : QUIET_STATUS.has(status) ? null : <Badge tone={statusTone[status]}>{sessionStatusLabels[status]}</Badge>}
          </button>
          <button type="button" className="qn-thread-archive" style={{ width: ARCHIVE_ACTION_WIDTH }}
            aria-label={thread.agent === 'codex' ? t('归档 {title}', { title: thread.title }) : t('归档 {title}（仅此手机）', { title: thread.title })}
            aria-disabled={archiving} aria-busy={archiving} onFocus={() => setRevealedDesktop(desktopId)}
            onPointerDown={startArchiveTouch} onPointerMove={trackArchiveTouch} onPointerUp={finishArchiveTouch}
            onPointerCancel={(event) => trackArchiveTouch(event, true)}
            onLostPointerCapture={(event) => trackArchiveTouch(event, true)}
            onClick={(event) => {
              if (!archiveTouch.current || event.detail === 0) void archive()
            }}>
            {archiving ? t('归档中…') : t('归档')}
            {thread.agent !== 'codex' && !archiving && <small>{t('仅此手机')}</small>}
          </button>
        </div>
        {desktopId && <Button variant="ghost" className="qn-list-action" aria-label={t('{title} 的会话操作', { title: thread.title })}
          aria-haspopup="dialog" onClick={() => { setRenameError(null); setMenu('actions') }}><Ellipsis size={18} aria-hidden /></Button>}
      </div>
      {archiveError && <p className="qn-thread-archive-error" role="alert">{archiveError}</p>}
      {menu && desktopId && (
        <Dialog title={menu === 'rename' ? t('重命名会话') : thread.title} onClose={() => { if (!renaming) setMenu(null) }}>
          {menu === 'actions' ? <>
            <SheetAction icon={preference?.pinned ? PinOff : Pin} onClick={() => {
              changeThreadPreference(desktopId, thread, { pinned: !preference?.pinned })
              setMenu(null)
            }}>{preference?.pinned ? t('取消置顶（仅此手机）') : t('置顶（仅此手机）')}</SheetAction>
            <SheetAction icon={Pencil} onClick={() => { setName(thread.title); setMenu('rename') }}>
              {thread.agent !== 'codex' ? t('重命名（仅此手机）') : t('重命名')}
            </SheetAction>
            <SheetAction icon={Archive} disabled={archiving} onClick={() => { setMenu(null); void archive() }}>
              {thread.agent !== 'codex' ? t('归档（仅此手机）') : t('归档')}
            </SheetAction>
          </> : <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void rename() }}>
            <input className="qn-input" aria-label={t('会话名称')} value={name} onChange={(event) => setName(event.target.value)} disabled={renaming} />
            {renameError && <Note tone="error" message={renameError} />}
            <Button variant="primary" type="submit" disabled={renaming || !name.trim()}>{renaming ? t('保存中…') : t('保存')}</Button>
          </form>}
        </Dialog>
      )}
    </div>
  )
}

export function WorkspaceProjectRow({ project, target, onOpen, sortable = false }: {
  project: Project
  target?: Target
  onOpen: () => void
  sortable?: boolean
}) {
  return (
    <div className="qn-row qn-list-row">
      <button type="button" className="qn-row-trigger" onClick={onOpen} disabled={!target}>
        <span className="qn-row-copy">
          <span className="qn-list-primary qn-clamp-2" title={project.name}>{project.name}</span>
          <span className="qn-subtitle qn-mono block" title={project.path}>{displayPath(project.path)}</span>
        </span>
      </button>
      {target && <NewSessionButton project={project} iconOnly className="qn-list-action" />}
      <ProjectTools project={project} compact sortable={sortable} />
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
  const label = expanded ? t('收起') : t('显示更多（{count} 条）', { count: remaining })
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
  const [projectTargetId, setProjectTargetId] = useState<string | null>(null)
  const [projectFilterOpen, setProjectFilterOpen] = useState(false)
  const preferences = useWorkspacePreferences()
  const selectedProjectTarget = targets.find((target) => target.id === projectTargetId)
  const activeProjectTarget = selectedProjectTarget?.id ?? null
  const projects = projectList?.items ?? emptyProjects
  const projectGroups = useMemo(() => {
    const matched = filterProjects(projects, targets, query, activeProjectTarget)
    return targets.map((target) => ({ target, rows: orderWorkspaceProjects(matched.filter((item) => item.targetId === target.id), preferences?.projectOrders[target.id]) }))
      .filter(({ rows }) => rows.length > 0)
  }, [projects, targets, query, activeProjectTarget, preferences])
  const groups = useMemo(() => groupWorkspaceThreads(visibleWorkspaceThreads(threadList, desktopId, archived), projects, query, preferences),
    [threadList, desktopId, archived, projects, query, preferences])

  const refresh = useCallback(async () => {
    if (desktopId) await Promise.all([loadTargets(), loadProjects(desktopId)])
  }, [desktopId, loadTargets, loadProjects])

  useEffect(() => { if (connected) void refresh() }, [connected, tab, refresh])

  const isSessions = tab === 'sessions'
  const searching = query.trim().length > 0
  const showTargets = () => {
    useApp.getState().cancelPendingNavigation()
    useApp.setState({ page: 'targets', targetsReturnPage: 'workspace' })
  }
  return (
    <PullToRefresh className="qn-body qn-scroll qn-workspace qn-workspace-home qn-rise"
      label={pageName(isSessions ? 'sessions' : 'projects')} disabled={!desktopId || projectList?.loading} onRefresh={refresh}>
      {repairReason && desktopId && (
        <Note message={repairReason === 'fingerprint' ? t('电脑证书已变化，请核对后重新配对。') : t('电脑已撤销此设备的授权。')}
          tone="error" actionLabel={t('重新配对')} onAction={() => beginRepair(desktopId)} />
      )}
      {notice && <Note message={notice} tone="warn" />}
      {error && <Note message={error} tone="error" onClose={clearError} />}
      {connected && projectList?.error && !repairReason && (
        <Note message={t('读取项目失败，请检查电脑和网络。')} tone="error" actionLabel={t('重试')} onAction={() => void refresh()} />
      )}
      {projectList?.loading && projects.length === 0 ? <Loading text={t('正在读取项目…')} /> : (
        <>
          {/* 新建会话从各项目分组标题的 + 进入，顶部不再放全局入口。 */}
          <WorkspaceSearch label={isSessions ? t('搜索会话或项目') : t('搜索项目、主机或路径')} query={query} onChange={setQuery} />
          {!isSessions && (
            <>
              <button type="button" className="qn-row qn-project-filter"
                aria-haspopup="dialog" aria-expanded={projectFilterOpen} onClick={() => setProjectFilterOpen(true)}>
                <Monitor size={17} className="shrink-0 text-qn-muted" aria-hidden />
                <span className="shrink-0 text-qn-muted">{t('主机')}</span>
                <span className="min-w-0 flex-1 truncate text-right">{selectedProjectTarget?.name ?? t('全部主机')}</span>
                <ChevronDown size={16} className="shrink-0 text-qn-muted" aria-hidden />
              </button>
              {projectFilterOpen && (
                <Dialog title={t('按主机筛选项目')} onClose={() => setProjectFilterOpen(false)}>
                  <div className="grid gap-1">
                    {[{ id: null, name: t('全部主机') }, ...targets].map(({ id, name }) => (
                      <button type="button" key={id === null ? 'all' : `target:${id}`}
                        className="qn-row qn-project-filter-option" aria-pressed={id === activeProjectTarget}
                        onClick={() => { setProjectTargetId(id); setProjectFilterOpen(false) }}>
                        <span className="min-w-0 flex-1 wrap-anywhere">{name}</span>
                        {id === activeProjectTarget && <Check size={16} className="shrink-0 text-qn-accent" aria-hidden />}
                      </button>
                    ))}
                  </div>
                </Dialog>
              )}
            </>
          )}
          {isSessions ? (
            groups.length ? groups.map(({ project, threads }) => (
              <section key={JSON.stringify([desktopId, project.targetId, project.id])} className="qn-workspace-group">
                <div className="qn-group-heading">
                  <button type="button" className="qn-group-title" onClick={() => void showWorkspaceProject(project)}
                    aria-label={t('进入 {name} 项目的会话', { name: project.name })}>
                    <h2 className="truncate">{project.name}</h2>
                    <ProjectOrigin target={targets.find((item) => item.id === project.targetId)} />
                    <ChevronRight size={15} className="shrink-0 text-qn-dim" aria-hidden />
                  </button>
                  {targets.some((item) => item.id === project.targetId) && <NewSessionButton project={project} iconOnly className="qn-list-action" />}
                  <ProjectTools project={project} compact />
                </div>
                <WorkspaceThreadList threads={threads} projectName={project.name} searching={searching}
                  onOpen={(thread) => void openWorkspaceThread(thread, project)} />
              </section>
            )) : (
              <Empty>
                <p>{query ? t('没有匹配的会话。') : t('还没有最近访问的会话。')}</p>
                <button type="button" className="qn-dashed-action qn-pressable" onClick={() => { setQuery(''); setTab('projects') }}>{t('选择项目')}</button>
              </Empty>
            )
          ) : (
            projectGroups.length ? projectGroups.map(({ target, rows }) => (
              <section key={target.id} className="qn-workspace-group">
                <div className="qn-group-heading">
                  <h2><ProjectOrigin target={target} /></h2>
                </div>
                <SortableList items={rows} itemKey={(project) => project.id} disabled={searching || !desktopId}
                  label={t('{name} 的项目', { name: target.name })} onMove={(from, to) => desktopId && placeWorkspaceProject(desktopId, rows, from, to)}>
                  {(project) => <WorkspaceProjectRow project={project} target={target} sortable={!searching && rows.length > 1}
                    onOpen={() => void showWorkspaceProject(project)} />}
                </SortableList>
              </section>
            )) : (
              <Empty>
                {searching ? t('没有匹配的项目。') : activeProjectTarget === null ? t('在目标中选择或添加项目。') : t('此连接下暂无项目。')}
              </Empty>
            )
          )}
          {(!isSessions || groups.length > 0) && (
            <button type="button" className="qn-text-action" onClick={isSessions ? () => { setQuery(''); setTab('projects') } : showTargets}>
              {isSessions ? t('从其他项目打开会话') : t('管理目标与项目')}<ChevronRight size={15} aria-hidden />
            </button>
          )}
        </>
      )}
    </PullToRefresh>
  )
}
