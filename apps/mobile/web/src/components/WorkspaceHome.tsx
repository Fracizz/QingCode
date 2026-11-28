import { sessionStatusLabels, type SessionStatus, t, translateMessage } from '@qn/codex-client'
import { Archive, ChartColumn, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Cloud, Ellipsis, Folder, MessageCircleMore, Monitor, Pencil, Pin, PinOff, RotateCw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { sessionKey } from '../agents'
import { useMobilePreferences } from '../mobilePreferences'
import { pageName } from '../names'
import { useApp } from '../store'
import type { Project, Target } from '../types'
import {
  filterProjects,
  changeThreadPreference,
  applyGroupOrder,
  groupWorkspaceThreads,
  isWorkspaceTabDoubleTap,
  openWorkspaceThread,
  orderWorkspaceProjects,
  pinnedFirst,
  placeWorkspaceGroup,
  placeWorkspaceProject,
  placeWorkspaceThread,
  renameCachedThread,
  recentThreadStatus,
  setWorkspaceActivityPriority,
  threadPreviewLine,
  displayPath,
  showWorkspaceProject,
  stickyGroupOrder,
  threadPreferenceKey,
  useWorkspace,
  useWorkspacePreferences,
  visibleWorkspaceThreads,
  workspaceGroupKey,
  workspaceProjectKey,
  workspaceThreadKey,
  type WorkspaceTab,
  type WorkspaceThread,
  toggleProjectCollapse,
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
  { id: 'usage', title: pageName('usage') },
  { id: 'connections', title: pageName('connections') },
]

const statusTone: Record<SessionStatus, 'muted' | 'accent' | 'warn' | 'danger'> = {
  idle: 'muted', running: 'accent', pending: 'warn', input: 'warn', completed: 'muted',
  failed: 'danger', interrupted: 'muted', unread: 'accent',
}
const QUIET_STATUS = new Set<SessionStatus>(['idle', 'completed', 'interrupted'])
const emptyProjects: Project[] = []
const emptyThreads: WorkspaceThread[] = []

const workspaceIcons = {
  sessions: MessageCircleMore,
  usage: ChartColumn,
  projects: Folder,
  connections: Monitor,
  search: Search,
  refresh: RotateCw,
  more: Ellipsis,
} as const

// 每台电脑的项目分组顺序，本次运行内固定，避免项目随会话状态来回跳。
const projectGroupOrders = new Map<string, string[]>()

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
        <button type="button" key={id} className="qn-nav-button" data-tab={id} aria-current={id === tab ? 'page' : undefined}
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

/** 会话分组标题里的来源小标签（rust 版样式）：远端与直连带上主机地址，同名项目也能分清在哪台机器。远端靠颜色区分，只显示地址。 */
function SourceTag({ target }: { target?: Target }) {
  if (!target) return <span className="qn-source-tag">{t('目标已移除')}</span>
  const label = target.kind === 'ssh' ? target.host
    : target.kind === 'direct' ? t('直连 · {host}', { host: target.host }) : t('本机')
  // 外层样式用 rtl 让省略号落在开头、保住地址末尾；bdi 保证文字本身仍按从左到右排。
  return <span className="qn-source-tag" data-kind={target.kind} title={target.kind === 'local' ? undefined : `${target.name} · ${target.host}:${target.port}`}><bdi dir="ltr">{label}</bdi></span>
}

// 首字母头像与电脑版项目树一致：同样的取色算法和尺寸，同一项目在两端颜色相同。
const INITIAL_COLORS = [
  'bg-qn-avatar-1', 'bg-qn-avatar-2', 'bg-qn-avatar-3', 'bg-qn-avatar-4',
  'bg-qn-avatar-5', 'bg-qn-avatar-6', 'bg-qn-avatar-7', 'bg-qn-avatar-8',
]

function ProjectInitial({ name }: { name: string }) {
  const ch = (Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? Array.from(name)[0] ?? '?').toUpperCase()
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)!) | 0
  const color = INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length]
  // 用 SVG 按字形几何居中：CSS 行盒按 ascent/descent 居中，大写字母会偏上。
  // 拉丁字母/数字以基线 + 约 0.36em 让大写字高居中；中日韩字符用 central 基线。
  const latin = /^[\p{Script=Latin}\p{N}]$/u.test(ch)
  return (
    <span aria-hidden className={`inline-flex size-[18px] shrink-0 rounded-md text-white ${color}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" className="block">
        <text x="9" y={latin ? 13 : 9} textAnchor="middle" dominantBaseline={latin ? 'alphabetic' : 'central'}
          fontSize="11" fontWeight="600" fill="currentColor">
          {ch}
        </text>
      </svg>
    </span>
  )
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

  /** 长按进入拖动排序后，本次触摸只用于排序，不再左滑归档或打开会话。 */
  const sorting = () => row.current?.closest('[data-sorting="true"]') != null

  function moveSwipe(event: PointerEvent<HTMLButtonElement>) {
    const start = gesture.current
    if (!start || start.id !== event.pointerId) return
    if (sorting()) {
      start.axis = 'vertical'
      suppressClick.current = true
      setDragOffset(null)
      return
    }
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
    if (cancelled || sorting()) {
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
      const connection = useApp.getState().connections.find((item) => item.id === desktopId)
      const saved = await renameConversation(thread.targetId, thread.id, title, thread.agent)
      if (connection && useApp.getState().connections.some((item) => item.id === desktopId && item.fp === connection.fp)) {
        changeThreadPreference(desktopId, thread, { title: saved === 'local' ? title : undefined })
        if (saved === 'native') renameCachedThread(desktopId, thread, title)
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
              // 与未读圆点一致只留图标，文字交给读屏。
              <LoadingIcon className="text-qn-accent" role="img" aria-hidden={false} aria-label={sessionStatusLabels[status]} />
            ) : status === 'unread' ? (
              <span className="qn-unread-dot shrink-0" role="img" aria-label={sessionStatusLabels[status]} />
            ) : QUIET_STATUS.has(status) ? null : <Badge tone={statusTone[status]}>{sessionStatusLabels[status]}</Badge>}
          </button>
          <button type="button" className="qn-thread-archive" style={{ width: ARCHIVE_ACTION_WIDTH }}
            aria-label={t('归档 {title}', { title: thread.title })}
            aria-disabled={archiving} aria-busy={archiving} onFocus={() => setRevealedDesktop(desktopId)}
            onPointerDown={startArchiveTouch} onPointerMove={trackArchiveTouch} onPointerUp={finishArchiveTouch}
            onPointerCancel={(event) => trackArchiveTouch(event, true)}
            onLostPointerCapture={(event) => trackArchiveTouch(event, true)}
            onClick={(event) => {
              if (!archiveTouch.current || event.detail === 0) void archive()
            }}>
            {archiving ? t('归档中…') : t('归档')}
          </button>
        </div>
        {desktopId && <Button variant="ghost" className="qn-list-action" aria-label={t('{title} 的会话操作', { title: thread.title })}
          aria-haspopup="dialog" onClick={() => { setRenameError(null); setMenu('actions') }}><Ellipsis size={18} aria-hidden /></Button>}
      </div>
      {archiveError && <p className="qn-thread-archive-error" role="alert">{archiveError}</p>}
      {menu && desktopId && (
        <Dialog title={menu === 'rename' ? t('重命名会话') : thread.title} onClose={() => { if (!renaming) setMenu(null) }}>
          {menu === 'actions' ? <div className="qn-sheet-actions">
            <SheetAction icon={preference?.pinned ? PinOff : Pin} onClick={() => {
              changeThreadPreference(desktopId, thread, { pinned: !preference?.pinned })
              setMenu(null)
            }}>{preference?.pinned ? t('取消置顶（仅此手机）') : t('置顶（仅此手机）')}</SheetAction>
            <SheetAction icon={Pencil} onClick={() => { setName(thread.title); setMenu('rename') }}>
              {t('重命名')}
            </SheetAction>
            <SheetAction icon={Archive} disabled={archiving} onClick={() => { setMenu(null); void archive() }}>
              {t('归档')}
            </SheetAction>
          </div> : <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void rename() }}>
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
      {target && <NewSessionButton project={project} iconOnly className="qn-list-action qn-new-session" />}
      <ProjectTools project={project} compact sortable={sortable} />
    </div>
  )
}

function WorkspaceThreadList({ project, threads, searching, onOpen }: {
  project: Project
  threads: WorkspaceThread[]
  searching: boolean
  onOpen: (thread: WorkspaceThread) => void
}) {
  const desktopId = useApp((s) => s.activeId)
  const previewCount = useMobilePreferences((state) => state.sessionPreviewCount)
  const [expanded, setExpanded] = useState(false)
  const shown = searching || expanded ? threads : threads.slice(0, previewCount)
  const remaining = threads.length - previewCount
  const label = expanded ? t('收起') : t('显示更多（{count} 条）', { count: remaining })

  return (
    <div className="qn-list-group qn-list-plain">
      {/* 长按拖动排序；收起时只排前几条，序号与完整列表一致，保存时按完整列表算。 */}
      <SortableList items={shown} itemKey={workspaceThreadKey} disabled={searching || !desktopId} className=""
        label={t('{name} 的会话', { name: project.name })}
        onMove={(from, to) => { if (desktopId) placeWorkspaceThread(desktopId, project, threads, from, to) }}>
        {(thread) => <WorkspaceThreadRow thread={thread} onOpen={() => onOpen(thread)} />}
      </SortableList>
      {!searching && remaining > 0 && (
        <button type="button" className="qn-session-more qn-pressable" aria-label={`${label} · ${project.name}`}
          aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {label}<ChevronDown size={16} aria-hidden />
        </button>
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
  const targets = useApp((s) => s.targets)
  const loadTargets = useApp((s) => s.loadTargets)
  const loadProjects = useWorkspace((s) => s.loadProjects)
  const projectList = useWorkspace((s) => desktopId ? s.projects[desktopId] : undefined)
  const threadList = useWorkspace((s) => desktopId ? s.threads[desktopId] : undefined) ?? emptyThreads
  const activityPriority = useWorkspace((s) => desktopId ? s.activityPriority[desktopId] : undefined)
  const [query, setQuery] = useState('')
  const [projectTargetId, setProjectTargetId] = useState<string | null>(null)
  const [projectFilterOpen, setProjectFilterOpen] = useState(false)
  const preferences = useWorkspacePreferences()
  const selectedProjectTarget = targets.find((target) => target.id === projectTargetId)
  const activeProjectTarget = selectedProjectTarget?.id ?? null
  const projects = projectList?.items ?? emptyProjects
  const projectGroups = useMemo(() => {
    const matched = filterProjects(projects, targets, query, activeProjectTarget)
    return targets.map((target) => ({ target, rows: pinnedFirst(orderWorkspaceProjects(matched.filter((item) => item.targetId === target.id),
      preferences?.projectOrders[target.id]), preferences?.pinnedProjects, workspaceProjectKey) }))
      .filter(({ rows }) => rows.length > 0)
  }, [projects, targets, query, activeProjectTarget, preferences])
  // 会话按创建时间固定排序，运行状态和新结果不再触发重排。
  const freshGroups = useMemo(() =>
    groupWorkspaceThreads(visibleWorkspaceThreads(threadList, desktopId, archived), projects, query, preferences),
  [threadList, desktopId, archived, projects, query, preferences])
  // 项目分组位置固定：只有新项目插到最前，已有项目不随会话状态重排。
  const baseOrder = useMemo(() => {
    const key = desktopId ?? ''
    const next = stickyGroupOrder(freshGroups.map(workspaceGroupKey), projectGroupOrders.get(key) ?? [])
    projectGroupOrders.set(key, next)
    // 拖动保存过的顺序优先，之后新出现的项目仍插到最前。
    return preferences?.groupOrder ? stickyGroupOrder(next, preferences.groupOrder) : next
  }, [freshGroups, desktopId, preferences])
  // 同一活动时间保留固定顺序，手动置顶始终在最前面。
  const groups = useMemo(() => {
    const order = activityPriority
      ? [...baseOrder].sort((a, b) => (activityPriority.get(b) ?? -1) - (activityPriority.get(a) ?? -1))
      : baseOrder
    return applyGroupOrder(freshGroups, pinnedFirst(order, preferences?.pinnedProjects, (item) => item))
  }, [freshGroups, baseOrder, activityPriority, preferences])

  const refresh = useCallback(async () => {
    if (desktopId) await Promise.all([loadTargets(), loadProjects(desktopId)])
  }, [desktopId, loadTargets, loadProjects])

  useEffect(() => { if (connected) void refresh() }, [connected, tab, refresh])

  const isSessions = tab === 'sessions'
  const searching = query.trim().length > 0
  const canSortGroups = !searching && !!desktopId && !activityPriority
  const pinnedGroupCount = groups.filter((group) => preferences?.pinnedProjects?.includes(workspaceGroupKey(group))).length
  const threadCount = groups.reduce((sum, group) => sum + group.threads.length, 0)
  const projectCount = projectGroups.reduce((sum, group) => sum + group.rows.length, 0)
  const pullRefresh = async () => {
    await refresh()
    if (desktopId && isSessions && activityPriority && useApp.getState().activeId === desktopId
      && useApp.getState().page === 'workspace' && useWorkspace.getState().tab === 'sessions'
      && useWorkspace.getState().activityPriority[desktopId] === activityPriority) {
      setWorkspaceActivityPriority(desktopId, true)
    }
  }
  const showTargets = () => {
    useApp.getState().cancelPendingNavigation()
    useApp.setState({ page: 'targets', targetsReturnPage: 'workspace' })
  }
  return (
    <PullToRefresh className="qn-body qn-scroll qn-workspace qn-workspace-home"
      label={pageName(isSessions ? 'sessions' : 'projects')} disabled={!desktopId || projectList?.loading} onRefresh={pullRefresh}
      scrollKey={JSON.stringify(['workspace', tab, desktopId])}>
      {/* 大标题、电脑延迟与设置入口统一放在「连接」页，会话和项目页顶部直接从内容开始。 */}
      {repairReason && desktopId && (
        <Note message={repairReason === 'fingerprint' ? t('电脑证书已变化，请核对后重新配对。') : t('电脑已撤销此设备的授权。')}
          tone="error" actionLabel={t('重新配对')} onAction={() => beginRepair(desktopId)} />
      )}
      {connected && projectList?.error && !repairReason && (
        <Note message={t('读取项目失败，请检查电脑和网络。')} tone="error" actionLabel={t('重试')} onAction={() => void refresh()} />
      )}
      {projectList?.loading && projects.length === 0 ? <Loading text={t('正在读取项目…')} /> : (
        <>
          {/* 新建会话从各项目分组标题的 + 进入，顶部不再放全局入口。 */}
          {isSessions && <div className="qn-list-label flex-wrap items-center">
            <span>{t('全部会话')}&nbsp;&nbsp;{threadCount}</span>
            {desktopId && <div className="qn-segment qn-workspace-sort" role="group" aria-label={t('项目排序')}>
              <button type="button" aria-pressed={!activityPriority}
                onClick={() => { if (activityPriority) setWorkspaceActivityPriority(desktopId, false) }}>{t('固定顺序')}</button>
              <button type="button" aria-pressed={!!activityPriority}
                onClick={() => { if (!activityPriority) setWorkspaceActivityPriority(desktopId, true) }}>{t('活动优先')}</button>
            </div>}
          </div>}
          <WorkspaceSearch label={isSessions ? t('搜索会话或项目') : t('搜索项目、主机或路径')} query={query} onChange={setQuery} />
          {isSessions && activityPriority && <p className="mx-1 mb-2 text-[13px] text-qn-muted">
            {t('运行中、待审批、待回答或有未读结果的项目按最近活动时间优先显示。下拉刷新更新顺序。')}
          </p>}
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
              <div className="qn-list-label"><span>{t('{count} 个项目', { count: projectCount })}</span></div>
            </>
          )}
          {isSessions ? (
            groups.length ? (
              // 长按项目标题拖动整个分组；拖动期间收起会话，方便跨多个项目移动。
              <SortableList items={groups} itemKey={(group) => JSON.stringify([desktopId, workspaceGroupKey(group)])}
                className="qn-group-sort" handle=".qn-group-title" collapse disabled={!canSortGroups} label={pageName('projects')}
                clamp={(from, to) => from < pinnedGroupCount ? Math.min(to, pinnedGroupCount - 1) : Math.max(to, pinnedGroupCount)}
                onMove={(from, to) => {
                  const moved = groups[from]
                  const anchor = groups[to]
                  if (desktopId && moved && anchor) placeWorkspaceGroup(desktopId, baseOrder, workspaceGroupKey(moved), workspaceGroupKey(anchor))
                }}>
                {({ project, threads }) => {
                  const collapsed = preferences?.collapsedProjects?.includes(workspaceProjectKey(project)) ?? false
                  return <section className="qn-workspace-group">
                    <div className="qn-group-heading">
                      <button type="button" className="qn-group-title" onClick={() => void showWorkspaceProject(project)}
                        aria-label={t('进入 {name} 项目的会话', { name: project.name })}>
                        <ProjectInitial name={project.name} />
                        <h2 className="truncate">{project.name}</h2>
                        {preferences?.pinnedProjects?.includes(workspaceProjectKey(project))
                          && <Pin size={13} className="shrink-0 text-qn-muted" aria-label={t('已置顶')} />}
                        <SourceTag target={targets.find((item) => item.id === project.targetId)} />
                        <span className="qn-group-count">{threads.length}</span>
                      </button>
                      {targets.some((item) => item.id === project.targetId) && <NewSessionButton project={project} iconOnly className="qn-list-action qn-new-session" />}
                      {/* 搜索时总是展示匹配结果，收起操作此时看不出效果，不提供。 */}
                      <ProjectTools project={project} compact sortable={canSortGroups && groups.length > 1}
                        actions={searching || !desktopId ? undefined : [{
                          icon: collapsed ? ChevronsUpDown : ChevronsDownUp,
                          label: collapsed ? t('展开会话') : t('收起项目会话'),
                          onClick: () => toggleProjectCollapse(desktopId, project),
                        }]} />
                    </div>
                    {(searching || !collapsed) && <WorkspaceThreadList project={project} threads={threads} searching={searching}
                      onOpen={(thread) => void openWorkspaceThread(thread, project)} />}
                  </section>
                }}
              </SortableList>
            ) : (
              <Empty>
                <p>{query ? t('没有匹配的会话。') : t('还没有最近访问的会话。')}</p>
                <button type="button" className="qn-dashed-action qn-pressable" onClick={() => { setQuery(''); setTab('projects') }}>{t('选择项目')}</button>
              </Empty>
            )
          ) : (
            projectGroups.length ? projectGroups.map(({ target, rows }) => (
              <section key={target.id} className="qn-workspace-group">
                <div className="qn-group-heading">
                  {target.kind === 'local'
                    ? <Folder size={18} strokeWidth={1.75} className="qn-group-icon" aria-hidden />
                    : <Cloud size={18} strokeWidth={1.75} className="qn-group-icon" data-kind={target.kind} aria-hidden />}
                  <h2 className="ml-1.5 min-w-0 flex-1 truncate"><ProjectOrigin target={target} /></h2>
                  <span className="qn-group-count px-3">{rows.length}</span>
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
