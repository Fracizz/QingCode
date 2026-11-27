import { useEffect, useMemo, useRef, useState, type ComponentProps, type DragEvent, type KeyboardEvent } from 'react'
import { Copy, Ellipsis, FolderPlus, Pencil, Pin, PinOff, SquarePen, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { copyText } from '../../lib/clipboard'
import type { Project, Target, TargetState } from '../../../../shared/backendApi'
import { sessionKey } from '../../lib/agents'
import { targetDotClass, targetStateLabel } from '../../lib/targetStatus'
import { applyThreadPrefs } from '../../lib/threadPrefs'
import { activeFirst, isThreadInProgress, threadKey, type ThreadSummary } from '../../lib/threads'
import { threadListFor, useCodex } from '../../store/codex'
import { projectListOf, useProjects, type ProjectPlacement } from '../../store/projects'
import { useTargets } from '../../store/targets'
import { useThreadPrefs } from '../../store/threadPrefs'
import { useUi, type ThreadListReveal } from '../../store/ui'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../primitives'
import { StatusDot } from '../StatusDot'
import { ErrorNote, IconButton, Spinner } from '../ui'
import { ThreadRow } from './ThreadRow'

const THREAD_PREVIEW_LIMIT = 8
const noThreads: ThreadSummary[] = []
const PROJECT_DRAG_TYPE = 'application/x-qingcode-project'

type ProjectDrop = { id: string; placement: ProjectPlacement }
type SortProps = Pick<ComponentProps<'button'>, 'onDragStart' | 'onDragEnd' | 'onKeyDown'>

/**
 * 某个目标下的项目 → 会话两级树（参考 Codex 侧栏）：侧栏里每个铺开的目标各渲染一份。
 * 每个展开的项目按自己的 cwd 读会话列表，可同时展开多个。
 */
export function ProjectTree({ target, onSelectTarget, activeSessionPaths }: {
  target: Target
  onSelectTarget: (id: string) => void
  activeSessionPaths?: ReadonlySet<string>
}) {
  const { id: targetId, name: targetName } = target
  const targetState = useTargets((s) => s.states[targetId]?.state ?? 'idle')
  const { projects, loading, error: projectError } = useProjects((s) => projectListOf(s, targetId))
  const selectedId = useProjects((s) => (s.targetId === targetId ? s.selectedId : null))
  const load = useProjects((s) => s.load)
  const select = useProjects((s) => s.select)
  const expandedIds = useProjects((s) => s.treeByTarget.get(targetId)?.expandedIds)
  const setExpanded = useProjects((s) => s.setExpanded)
  const move = useProjects((s) => s.move)
  const pinned = useProjects((s) => s.pinned)
  const openPicker = useUi((s) => s.openDirectoryPicker)
  const reveal = useUi((s) => s.threadListReveal)
  const activeTarget = useTargets((s) => s.selectedId)
  const orderedProjects = activeSessionPaths ? activeFirst(projects, (project) => activeSessionPaths.has(project.path)) : projects

  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<ProjectDrop | null>(null)

  useEffect(() => {
    setDraggedId(null)
    setDropTarget(null)
    void load(targetId)
  }, [targetId, load])

  useEffect(() => {
    if (reveal && (reveal.targetId !== targetId || reveal.projectId !== selectedId || !expandedIds?.includes(reveal.projectId))) {
      useUi.getState().finishThreadListReveal(reveal)
    }
  }, [reveal, targetId, selectedId, expandedIds])

  /** 切到项目所在目标（未连接时会发起连接），再打开项目。 */
  const activateProject = (project: Project) => {
    if (activeTarget !== targetId) onSelectTarget(targetId)
    if (project.id !== selectedId) void select(project)
  }

  const onProjectClick = (project: Project, expanded: boolean) => {
    if (!expanded) activateProject(project)
    setExpanded(project, !expanded)
  }

  const newDraftIn = (project: Project) => {
    // 先切到该项目再进入草稿态：会话在发第一条消息时才创建，不留空会话。
    activateProject(project)
    useCodex.getState().startDraft()
    setExpanded(project, true)
  }

  const clearDrag = () => {
    setDraggedId(null)
    setDropTarget(null)
  }

  const locateDrop = (event: DragEvent<HTMLDivElement>, id: string): ProjectDrop | null => {
    if (!draggedId || draggedId === id || !event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)
      || pinned.includes(draggedId) !== pinned.includes(id)) return null
    const rect = event.currentTarget.getBoundingClientRect()
    return { id, placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' }
  }

  return (
    <div className="qn-project-tree pb-1">
      {loading && projects.length === 0 && (
        <div className="space-y-1.5 px-2 py-1">
          {[0, 1].map((key) => (
            <div key={key} className="h-7 animate-pulse rounded-lg bg-qn-panel" />
          ))}
        </div>
      )}

      {!loading && projects.length === 0 && !projectError && (
        <button
          type="button"
          className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[length:var(--qn-project-detail-font-size)] leading-tight text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          onClick={() => openPicker(targetId)}
        >
          <FolderPlus size={14} /> 添加项目
        </button>
      )}

      {orderedProjects.map((project, index) => {
        const active = project.id === selectedId
        const expanded = expandedIds?.includes(project.id) ?? false
        const isPinned = pinned.includes(project.id)
        const previous = projects[index - 1]
        const next = projects[index + 1]
        const canMoveUp = previous && pinned.includes(previous.id) === isPinned
        const canMoveDown = next && pinned.includes(next.id) === isPinned
        const sortProps: SortProps | undefined = !activeSessionPaths && (canMoveUp || canMoveDown) ? {
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)
            setDraggedId(project.id)
          },
          onDragEnd: clearDrag,
          onKeyDown: (event) => {
            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            if (event.key === 'ArrowUp' && canMoveUp) {
              event.preventDefault()
              move(project.id, previous.id, 'before')
            } else if (event.key === 'ArrowDown' && canMoveDown) {
              event.preventDefault()
              move(project.id, next.id, 'after')
            }
          },
        } : undefined
        const indicator = dropTarget?.id === project.id ? dropTarget.placement : null
        return (
          <div
            key={project.id}
            className={`relative${index > 0 ? ' mt-2' : ''}${draggedId === project.id ? ' opacity-50' : ''}`}
            onDragOver={(event) => {
              const target = locateDrop(event, project.id)
              if (target) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }
              setDropTarget((current) => current?.id === target?.id && current?.placement === target?.placement ? current : target)
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
              setDropTarget((current) => current?.id === project.id ? null : current)
            }}
            onDrop={(event) => {
              const target = locateDrop(event, project.id)
              if (target && draggedId && event.dataTransfer.getData(PROJECT_DRAG_TYPE) === draggedId) {
                event.preventDefault()
                move(draggedId, target.id, target.placement)
                clearDrag()
              }
            }}
          >
            {indicator && (
              <div aria-hidden className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-qn-accent ${indicator === 'before' ? 'top-0' : 'bottom-0'}`} />
            )}
            <ProjectRow
              project={project}
              targetName={targetName}
              targetState={targetState}
              active={active}
              expanded={expanded}
              hasActiveSessions={!expanded && activeSessionPaths?.has(project.path)}
              onOpen={() => onProjectClick(project, expanded)}
              onNewDraft={() => newDraftIn(project)}
              sortProps={sortProps}
            />
            {expanded && (
              <ThreadList
                project={project}
                active={active}
                runningFirst={activeSessionPaths !== undefined}
                reveal={reveal?.targetId === targetId && reveal.projectId === project.id ? reveal : null}
                onActivate={() => activateProject(project)}
                onNewDraft={() => newDraftIn(project)}
              />
            )}
          </div>
        )
      })}

      <ErrorNote message={projectError} variant="compact" className="mx-1 mt-1" onRetry={() => void load(targetId)} />
    </div>
  )
}

function ProjectRow({
  project,
  targetName,
  targetState,
  active,
  expanded,
  hasActiveSessions,
  onOpen,
  onNewDraft,
  sortProps,
}: {
  project: Project
  targetName: string
  targetState: TargetState
  active: boolean
  expanded: boolean
  hasActiveSessions?: boolean
  onOpen: () => void
  onNewDraft: () => void
  sortProps?: SortProps
}) {
  const pinned = useProjects((s) => s.pinned.includes(project.id))
  const togglePin = useProjects((s) => s.togglePin)
  const rename = useProjects((s) => s.rename)
  const remove = useProjects((s) => s.remove)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    // 等菜单关闭、焦点归还后再聚焦，否则会被 Radix 抢回去。
    const timer = setTimeout(() => inputRef.current?.select(), 0)
    return () => clearTimeout(timer)
  }, [editing])

  const commit = () => {
    setEditing(false)
    void rename(project, draft)
  }

  if (editing) {
    return (
      <div className="flex min-h-8 items-center gap-(--qn-tree-row-inset) pl-(--qn-tree-row-inset) pr-1">
        <ProjectInitial name={project.name} />
        <input
          ref={inputRef}
          value={draft}
          aria-label="项目名称"
          className="qn-input min-h-7 min-w-0 flex-1 px-1.5 py-0 text-[length:var(--qn-project-detail-font-size)] leading-tight"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') setEditing(false)
          }}
        />
      </div>
    )
  }

  const shortcut = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    const action =
      key === 'p' ? () => togglePin(project.id) : key === 'e' ? () => beginRename() : key === 'c' ? copyPath : null
    if (!action) return
    event.preventDefault()
    setMenuOpen(false)
    action()
  }
  const beginRename = () => {
    setDraft(project.name)
    setEditing(true)
  }
  const copyPath = () => void copyText(project.path)

  return (
    <div
      className={`group/project flex min-h-8 items-center gap-2 rounded-lg pl-(--qn-tree-row-inset) pr-2 text-[length:var(--qn-project-font-size)] leading-tight ${
        active ? 'text-qn-text' : 'text-qn-text/85 hover:bg-qn-hover'
      } ${(active && !expanded) || menuOpen ? 'bg-qn-hover' : ''}`}
    >
      <button
        type="button"
        className={`group flex min-w-0 flex-1 items-center gap-(--qn-tree-row-inset) self-stretch rounded-md py-px text-left outline-none focus-visible:ring-1 focus-visible:ring-qn-outline-hover ${sortProps && !active ? 'qn-cursor-drag' : 'cursor-default'}`}
        aria-expanded={expanded}
        aria-keyshortcuts={sortProps ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        draggable={Boolean(sortProps)}
        onClick={onOpen}
        {...sortProps}
      >
        <ProjectInitial name={project.name} />
        <span className="min-w-0 flex-1 truncate" title={project.name}>{project.name}</span>
        {hasActiveSessions && <StatusDot className="bg-qn-brand" title="有活动会话" />}
        {pinned && <Pin size={11} className="shrink-0 text-qn-dim" aria-label="已置顶" />}
        {sortProps && (
          <span title="拖动排序，或按 Alt+↑ / Alt+↓ 移动" className="hidden h-7 w-5 shrink-0 items-center justify-center text-qn-muted group-focus-visible:flex group-hover:flex">
            <DragHandleIcon />
          </span>
        )}
      </button>
      <span
        className={`max-w-[36%] min-w-0 shrink-0 items-center gap-1.5 text-[length:var(--qn-sidebar-list-detail-font-size)] text-qn-muted group-hover/project:hidden group-has-focus-visible/project:hidden ${menuOpen ? 'hidden' : 'flex'}`}
        title={`${targetName} · ${targetStateLabel[targetState]}`}
      >
        <span className="truncate">{targetName}</span>
        <StatusDot className={targetDotClass[targetState]} />
        <span className="sr-only">{targetStateLabel[targetState]}</span>
      </span>
      <span className={`shrink-0 items-center group-hover/project:flex group-has-focus-visible/project:flex ${menuOpen ? 'flex' : 'hidden'}`}>
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="更多操作"
              className="flex h-7 w-7 items-center justify-center rounded-md text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-outline-hover data-[state=open]:text-qn-text"
            >
              <Ellipsis size={15} />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="min-w-52" onKeyDown={shortcut}>
            <MenuItem icon={pinned ? <PinOff size={14} /> : <Pin size={14} />} hint="P" onSelect={() => togglePin(project.id)}>
              {pinned ? '取消置顶' : '置顶'}
            </MenuItem>
            <MenuItem icon={<Pencil size={14} />} hint="E" onSelect={beginRename}>
              重命名
            </MenuItem>
            <MenuItem icon={<Copy size={14} />} hint="C" onSelect={copyPath}>
              复制路径
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} title="不删除磁盘文件" onSelect={() => void remove(project.id)}>
              移除项目
            </MenuItem>
          </MenuContent>
        </Menu>
        <IconButton label="在此项目新建会话" className="h-7 w-7" onClick={onNewDraft}>
          <SquarePen size={14} />
        </IconButton>
      </span>
    </div>
  )
}

// 首字母头像配色：按项目名哈希取色，保证同名项目颜色稳定。
// 实色底 + 白字，比半透明底更像分组标签。
const INITIAL_COLORS = [
  'bg-qn-avatar-1',
  'bg-qn-avatar-2',
  'bg-qn-avatar-3',
  'bg-qn-avatar-4',
  'bg-qn-avatar-5',
  'bg-qn-avatar-6',
  'bg-qn-avatar-7',
  'bg-qn-avatar-8',
]

function ProjectInitial({ name }: { name: string }) {
  const ch = (Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? Array.from(name)[0] ?? '?').toUpperCase()
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)!) | 0
  const color = INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length]
  // 用 SVG 按字形几何居中：CSS 行盒按 ascent/descent 居中，Segoe UI 的大写字母会明显偏上。
  // 拉丁字母/数字以基线 + 约 0.36em 让大写字高居中；中日韩字符用 central 基线。
  const latin = /^[\p{Script=Latin}\p{N}]$/u.test(ch)
  return (
    <span aria-hidden className={`inline-flex size-(--qn-tree-icon-size) shrink-0 rounded-[5px] text-white ${color}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" className="block">
        <text
          x="9"
          y={latin ? 13 : 9}
          textAnchor="middle"
          dominantBaseline={latin ? 'alphabetic' : 'central'}
          fontSize="11"
          fontWeight="600"
          fill="currentColor"
        >
          {ch}
        </text>
      </svg>
    </span>
  )
}

function ThreadList({ project, active, runningFirst, reveal, onActivate, onNewDraft }: {
  project: Project
  active: boolean
  runningFirst: boolean
  reveal: ThreadListReveal | null
  onActivate: () => void
  onNewDraft: () => void
}) {
  const { targetId, id: projectId, path: cwd } = project
  const ready = useTargets((s) => s.states[targetId]?.state === 'ready')
  const list = useCodex((s) => threadListFor(s, targetId, cwd))
  const threadsLoading = list?.loading ?? ready
  const threadsError = list?.error
  const currentKey = useCodex((s) => active && s.currentTargetId === targetId && s.currentCwd === cwd && s.currentThreadId
    ? threadKey(s.currentAgent, s.currentThreadId) : null)
  const openError = useCodex((s) => active ? s.sessions[sessionKey(targetId, s.currentAgent)]?.openError : null)
  const refreshThreads = useCodex((s) => s.refreshThreads)
  const showAll = useProjects((s) => s.fullThreadLists.includes(projectId))
  const setShowAll = useProjects((s) => s.setShowAllThreads)
  const prefs = useThreadPrefs((s) => s.byTarget[targetId])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (ready && !threadListFor(useCodex.getState(), targetId, cwd)?.loading) {
      void refreshThreads({ targetId, cwd })
    }
  }, [ready, refreshThreads, targetId, cwd])

  const rawThreads = list?.threads ?? noThreads
  // 本地偏好：置顶在前、隐藏本地归档、套用本地名称。
  const defaultThreads = useMemo(() => applyThreadPrefs(rawThreads, prefs), [rawThreads, prefs])
  const activeThreads = useCodex(useShallow((s) => {
    if (!runningFirst || !ready) return null
    return new Set(defaultThreads.filter((thread) =>
      isThreadInProgress(thread, s.sessions[sessionKey(targetId, thread.agent)]?.state.threads[thread.id]),
    ))
  }))
  const threads = useMemo(() =>
    activeThreads?.size ? activeFirst(defaultThreads, (thread) => activeThreads.has(thread)) : defaultThreads,
  [activeThreads, defaultThreads])

  const currentIndex = currentKey ? threads.findIndex((thread) => threadKey(thread.agent, thread.id) === currentKey) : -1
  const limit = Math.max(THREAD_PREVIEW_LIMIT, activeThreads?.size ?? 0)
  const preview = threads.slice(0, limit)
  // 当前会话较旧时单独保留这一行，避免定位时展开整个列表。
  if (currentIndex >= limit) preview.push(threads[currentIndex]!)
  const shown = showAll ? threads : preview
  const remaining = threads.length - preview.length

  useEffect(() => {
    if (!reveal) return
    const finish = useUi.getState().finishThreadListReveal
    if (!active || reveal.threadKey !== currentKey) {
      finish(reveal)
      return
    }
    const container = listRef.current
    if (!container) return
    const row = currentKey ? container.querySelector<HTMLButtonElement>('button[aria-current="true"]') : null
    // 展开项目时列表可能刚开始加载，等会话行出现后再定位。
    if (currentKey && !row && threadListFor(useCodex.getState(), targetId, cwd)?.loading) return
    const element = row ?? container
    element.focus({ preventScroll: true })
    element.scrollIntoView({ block: row ? 'nearest' : 'start', inline: 'nearest' })
    finish(reveal)
  }, [reveal, active, currentKey, threads, threadsLoading, targetId, cwd])

  return (
    <div ref={listRef} role="group" aria-label={`${project.name}会话列表`} tabIndex={-1} className="flex flex-col gap-0.5 pt-0.5 pb-1.5">
      {threadsLoading && threads.length === 0 && (
        <div className="py-1.5 pl-(--qn-tree-title-start)">
          <Spinner label="加载会话…" />
        </div>
      )}

      {!threadsLoading && threads.length === 0 && !threadsError && (
        <button
          type="button"
          className="flex min-h-8 w-full items-center rounded-lg py-0.5 pl-(--qn-tree-title-start) text-left text-[length:var(--qn-session-font-size)] leading-tight text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          onClick={onNewDraft}
        >
          暂无会话，开始一个
        </button>
      )}

      {shown.map((thread) => {
        const key = threadKey(thread.agent, thread.id)
        return (
          <ThreadRow
            key={key}
            thread={thread}
            targetId={targetId}
            current={key === currentKey}
            onActivate={onActivate}
          />
        )
      })}

      {remaining > 0 && (
        <button
          type="button"
          className="min-h-7 w-full rounded-lg py-0.5 pl-(--qn-tree-title-start) text-left text-[length:var(--qn-session-detail-font-size)] leading-tight text-qn-muted hover:bg-qn-hover hover:text-qn-text"
          aria-expanded={showAll}
          onClick={() => setShowAll(projectId, !showAll)}
        >
          {showAll ? '收起会话' : `显示其余 ${remaining} 个会话`}
        </button>
      )}

      {/* 打开失败的原因已在对话区横幅展示，这里只在两者不同时补充。 */}
      {threadsError && threadsError !== openError && (
        <ErrorNote
          message={threadsError}
          variant="compact"
          className="mx-1 mt-1"
          retryIcon
          onRetry={() => void refreshThreads({ targetId, cwd })}
        />
      )}
      {threadsError && threadsError === openError && (
        <div className="py-1 pl-(--qn-tree-title-start) text-[length:var(--qn-session-detail-font-size)] leading-tight text-qn-muted">会话列表不可用</div>
      )}
    </div>
  )
}

/** 拖动握把：16px 网格上整数坐标的实心圆点，避免 lucide 描边圆点缩小后发虚。 */
function DragHandleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" shapeRendering="geometricPrecision" aria-hidden>
      {[4, 8, 12].map((y) => (
        <g key={y}>
          <circle cx="6" cy={y} r="1.5" />
          <circle cx="10" cy={y} r="1.5" />
        </g>
      ))}
    </svg>
  )
}
