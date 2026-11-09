import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  Check,
  Circle,
  ListChecks,
  LoaderCircle,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import { useTerminalTabActions } from '../hooks/useTerminalTabActions'
import { useTerminalProjectSelection } from '../hooks/useTerminalProjectSelection'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useTerminalStore, MAX_TERMINALS_PER_PROJECT } from '../store/terminalStore'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import {
  getTerminalActivityIndicator,
  subscribeTerminalActivityIndicator,
} from '@/lib/terminal/terminalActivitySettings'
import { shouldKeepShellAfterExit } from '@/lib/terminal/terminalShellLifecycle'
import {
  terminalHoverDetails,
  terminalRowStatus,
  terminalTabTooltip,
} from '@/lib/terminal/terminalTabPresentation'
import { formatCompactCreatedAge, formatFullCreatedTime } from '@/lib/terminal/terminalOverview'
import {
  getTerminalAttentionSnapshot,
  subscribeTerminalAttention,
} from '@/lib/terminal/terminalAttention'
import {
  groupTerminalSessions,
  parseCollapsedProjects,
  TERMINAL_LIST_COLLAPSED_KEY,
  terminalProjectMove,
  terminalProjectSources,
  type TerminalSessionGroup,
} from '@/lib/terminal/terminalSessionGroups'
import { projectChipTooltipLabel, projectHoverDetails } from '@/lib/projectChipTooltip'
import {
  allTerminalsSelected,
  isEndedTerminal,
  prunedTerminalSelection,
  toggleTerminalSelection,
} from '@/lib/terminal/terminalBatchSelection'
import { formatTerminalName } from '../utils/terminalName'
import ContextMenu from './ContextMenu'
import EmptyState from './EmptyState'
import InfoTipCard from './InfoTipCard'
import { ProjectKindIcon } from './ProjectKindMark'
import TerminalActivityDot from './TerminalActivityDot'
import TerminalRenameInput from './TerminalRenameInput'
import Tooltip from './Tooltip'
import type { TerminalTab } from '../types'

const HEADER_BUTTON =
  'flex ui-chip h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40'
const BAR_BUTTON =
  'rounded px-1.5 py-0.5 text-ui-xs text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40'
const ROW_BUTTON = 'flex ui-chip h-6 w-6 flex-shrink-0 items-center justify-center rounded'
const GROUP_ACTION = 'text-fg-muted hover:bg-bg-active hover:text-fg'

type PickState = 'on' | 'off' | 'mixed'

function PickBox({ state, ...rest }: { state: PickState } & Record<`data-${string}`, string>) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border ${
        state === 'off' ? 'border-border-strong' : 'border-fg bg-fg text-bg'
      }`}
      {...rest}
    >
      {state === 'on' && <Check size={11} strokeWidth={3} />}
      {state === 'mixed' && <Minus size={11} strokeWidth={3} />}
    </span>
  )
}

function loadCollapsedProjects(): ReadonlySet<string> {
  try {
    return parseCollapsedProjects(localStorage.getItem(TERMINAL_LIST_COLLAPSED_KEY))
  } catch {
    return new Set()
  }
}

function saveCollapsedProjects(collapsed: ReadonlySet<string>) {
  try {
    localStorage.setItem(TERMINAL_LIST_COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // 折叠状态只是便利项，写不进去时本次会话仍然生效。
  }
}

/** 返回当前时间，并在每天零点刷新，让列表里「今天」的时间过夜后变成日期。 */
function useNowRefreshedDaily(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const nextDay = new Date(now)
    nextDay.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(() => setNow(Date.now()), nextDay.getTime() - now)
    return () => window.clearTimeout(timer)
  }, [now])
  return now
}

/** 终端工作台左栏：按项目分组列出全部终端，替代横向标签栏。 */
export default function TerminalSessionList() {
  const actions = useTerminalTabActions({ dropAxis: 'vertical' })
  const now = useNowRefreshedDaily()
  const {
    translate,
    paneActiveId,
    currentProject,
    atLimit,
    creatingTerminal,
    contextMenu,
    setContextMenu,
    profileMenu,
    setProfileMenu,
    closeArmId,
    setCloseArmId,
    renamingId,
    renameDraft,
    setRenameDraft,
    draggedTerminalId,
    dropTarget,
    renameInputRef,
    renameCommittingRef,
    handleCloseClick,
    handleCloseAllInStrip,
    handleCloseSelected,
    startRename,
    commitRename,
    cancelRename,
    handleNewTerminal,
    profileMenuItems,
    clearTerminalDrag,
    handleTabDragStart,
    handleTabDragOver,
    handleTabDrop,
    menuItems,
    reloadTerminal,
  } = actions
  const projects = useProjectStore(s => s.projects)
  const sshConnections = useProjectStore(s => s.sshConnections)
  const reorderVisibleProjects = useProjectStore(s => s.reorderVisibleProjects)
  const allTerminals = useTerminalStore(s => s.terminals)
  const { pendingTerminalId, selectTerminal: selectAcrossProjects } = useTerminalProjectSelection()
  const attentionIds = useSyncExternalStore(subscribeTerminalAttention, getTerminalAttentionSnapshot)
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)
  const activityIndicator = useSyncExternalStore(
    subscribeTerminalActivityIndicator,
    getTerminalActivityIndicator,
  )
  const currentProjectId = currentProject?.id ?? null
  const [collapsedProjects, setCollapsedProjects] = useState(loadCollapsedProjects)
  const [seenProjectId, setSeenProjectId] = useState<string | null>(null)
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null)
  const [projectDrop, setProjectDrop] = useState<{ id: string; position: 'before' | 'after' } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; projectId: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [manageMode, setManageMode] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  const [closingBatch, setClosingBatch] = useState(false)
  const newDisabled = Boolean(currentProject && atLimit) || creatingTerminal

  // 切到某个项目时展开它，否则当前终端藏在折叠的分组里。
  if (seenProjectId !== currentProjectId) {
    setSeenProjectId(currentProjectId)
    if (currentProjectId && collapsedProjects.has(currentProjectId)) {
      const next = new Set(collapsedProjects)
      next.delete(currentProjectId)
      setCollapsedProjects(next)
    }
  }

  const groups = useMemo(() => {
    const listed =
      currentProject && !projects.some(project => project.id === currentProject.id)
        ? [currentProject, ...projects]
        : projects
    return groupTerminalSessions(listed, allTerminals)
  }, [allTerminals, currentProject, projects])
  const projectSources = terminalProjectSources(
    groups.map(group => group.project),
    sshConnections,
    translate,
  )
  const isExpanded = (group: TerminalSessionGroup) =>
    group.terminals.length > 0 && !collapsedProjects.has(group.project.id)
  const visibleTerminals = groups.flatMap(group => (isExpanded(group) ? group.terminals : []))
  const totalTerminals = groups.reduce((sum, group) => sum + group.terminals.length, 0)
  // 没有终端可管理时自动退出管理模式；只处理当前可见（已展开）的终端，避免关掉折叠分组里看不到的会话。
  const managing = manageMode && totalTerminals > 0
  const picked = prunedTerminalSelection(selection, visibleTerminals)
  const endedVisible = visibleTerminals.filter(isEndedTerminal)
  const allPicked = allTerminalsSelected(picked, visibleTerminals)
  const setManaging = (next: boolean) => {
    setManageMode(next)
    setSelection(new Set())
    setCloseArmId(null)
  }
  const closePicked = async () => {
    if (closingBatch || picked.size === 0) return
    setClosingBatch(true)
    try {
      await handleCloseSelected([...picked])
    } finally {
      setClosingBatch(false)
    }
  }

  // 没有当前终端时让第一行可被 Tab 聚焦，否则键盘进不了列表。
  const rovingTerminalId = visibleTerminals.some(term => term.id === paneActiveId)
    ? paneActiveId
    : (visibleTerminals[0]?.id ?? null)

  // 分组不再置顶，切换后要把当前终端（没有终端时是项目组）滚到可见位置。
  useEffect(() => {
    const list = listRef.current
    const row = paneActiveId
      ? list?.querySelector<HTMLElement>(`[data-terminal-session-row="${paneActiveId}"]`)
      : null
    const target =
      row ?? list?.querySelector<HTMLElement>(`[data-terminal-project-group="${currentProjectId}"]`)
    target?.scrollIntoView?.({ block: 'nearest' })
  }, [paneActiveId, currentProjectId])

  const clearProjectDrag = () => {
    setDraggedProjectId(null)
    setProjectDrop(null)
  }

  const projectMoveAt = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    if (!draggedProjectId) return null
    const rect = event.currentTarget.getBoundingClientRect()
    const position: 'before' | 'after' =
      event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    const move = terminalProjectMove(projects, draggedProjectId, targetId, position)
    return move ? { ...move, position } : null
  }

  const onProjectDragOver = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    if (!draggedProjectId) return
    const move = projectMoveAt(event, targetId)
    if (!move) {
      setProjectDrop(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setProjectDrop(current =>
      current?.id === targetId && current.position === move.position
        ? current
        : { id: targetId, position: move.position },
    )
  }

  const onProjectDrop = (event: ReactDragEvent<HTMLElement>, targetId: string) => {
    if (!draggedProjectId) return
    event.preventDefault()
    const move = projectMoveAt(event, targetId)
    if (move) void reorderVisibleProjects(move.fromIndex, move.toIndex)
    clearProjectDrag()
  }

  const setProjectCollapsed = (projectId: string, collapsed: boolean) => {
    if (collapsedProjects.has(projectId) === collapsed) return
    const next = new Set(collapsedProjects)
    if (collapsed) next.add(projectId)
    else next.delete(projectId)
    setCollapsedProjects(next)
    saveCollapsedProjects(next)
  }

  const selectTerminal = (term: TerminalTab) => {
    if (managing) {
      setSelection(toggleTerminalSelection(picked, term.id))
      return
    }
    void selectAcrossProjects(term)
    if (closeArmId && closeArmId !== term.id) setCloseArmId(null)
  }

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return
    if (managing && event.key === 'Escape') {
      event.preventDefault()
      setManaging(false)
      return
    }
    const count = visibleTerminals.length
    if (count === 0) return
    const focusedId = (event.target as Element).closest<HTMLElement>('[data-terminal-session-row]')
      ?.dataset.terminalSessionRow
    const current = visibleTerminals.findIndex(term => term.id === (focusedId ?? paneActiveId))
    let nextIndex: number
    if (event.key === 'ArrowDown') nextIndex = (current + 1) % count
    else if (event.key === 'ArrowUp') nextIndex = (current - 1 + count) % count
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = count - 1
    else return
    event.preventDefault()
    const next = visibleTerminals[nextIndex]
    if (!next) return
    // 其他项目只移动焦点、按 Enter 才切换：方向键扫过时不能触发信任弹窗或 SSH 连接。
    if (next.projectId === currentProjectId) selectTerminal(next)
    event.currentTarget
      .querySelector<HTMLElement>(`[data-terminal-session-row="${next.id}"]`)
      ?.focus()
  }

  const renderRow = (term: TerminalTab) => {
    const isActive = term.id === paneActiveId
    const isPicked = managing && picked.has(term.id)
    const isCloseArmed = closeArmId === term.id
    const isRenaming = renamingId === term.id
    const isPending = term.id === pendingTerminalId
    // 等待恢复的终端状态也是 exited，但进程并没有结束，不给重启入口。
    const exited = term.status === 'exited' && !term.awaitingRestoreSpawn
    const awaitingRestore = term.status === 'exited' && term.awaitingRestoreSpawn === true
    const keepShell = shouldKeepShellAfterExit(term)
    const exitCodeSuffix =
      term.exitCode === null ? '' : translate('（退出码 {code}）', { code: term.exitCode })
    const restartLabel = keepShell ? '重启终端{exitCode}' : '按原运行配置重启{exitCode}'
    const createdAt = term.createdAt ?? term.startedAt
    const created = formatCompactCreatedAge(createdAt, now, translate)
    const fullCreated = formatFullCreatedTime(createdAt)
    const tooltip = terminalTabTooltip(term, translate)
    // 关闭活动指示后没有空心点，待恢复要改用文字表达。
    const trailing =
      terminalRowStatus(term, translate) ??
      (awaitingRestore && !activityIndicator ? translate('待恢复') : created)
    return (
      <div
        key={term.id}
        role="tab"
        data-terminal-session-row={term.id}
        tabIndex={term.id === rovingTerminalId ? 0 : -1}
        aria-selected={managing ? isPicked : isActive}
        aria-busy={isPending || undefined}
        draggable={!isRenaming && !managing}
        className={`group relative flex min-h-7 flex-shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md py-0.5 pl-6 pr-1 transition-colors ${
          isPicked || (!managing && isActive)
            ? 'bg-bg-active text-fg'
            : 'text-tree-fg hover:bg-bg-hover hover:text-fg'
        } ${draggedTerminalId === term.id ? 'opacity-45' : ''}`}
        onDragStart={event => handleTabDragStart(event, term.id)}
        onDragOver={event => handleTabDragOver(event, term.id)}
        onDrop={event => handleTabDrop(event, term.id)}
        onDragEnd={clearTerminalDrag}
        onClick={() => selectTerminal(term)}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectTerminal(term)
          }
        }}
        onDoubleClick={event => {
          // 行内按钮的双击不能进入重命名（连点关闭时很常见）。
          if (managing) return
          if ((event.target as Element | null)?.closest?.('button, input, [data-terminal-close]')) return
          event.preventDefault()
          startRename(term.id, term.name)
        }}
        onContextMenu={(event: ReactMouseEvent) => {
          if (!shouldShowAppContextMenu(event)) return
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
          setContextMenu({ x: event.clientX, y: event.clientY, terminal: term })
        }}
      >
        {dropTarget?.id === term.id && draggedTerminalId !== term.id && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-brand ${
              dropTarget.position === 'before' ? '-top-px' : '-bottom-px'
            }`}
          />
        )}
        {managing && (
          <span className="-ml-5 flex flex-shrink-0">
            <PickBox state={isPicked ? 'on' : 'off'} data-terminal-pick={term.id} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {isRenaming ? (
            <TerminalRenameInput
              terminalId={term.id}
              draft={renameDraft}
              inputRef={renameInputRef}
              committingRef={renameCommittingRef}
              onDraftChange={setRenameDraft}
              onCommit={commitRename}
              onCancel={cancelRename}
              className="h-[var(--ui-chip-height)] w-full rounded-sm border border-accent bg-bg px-1.5 text-ui text-fg outline-none"
            />
          ) : (
            <Tooltip
              label={fullCreated ? `${tooltip}\n${translate('创建于 {time}', { time: fullCreated })}` : tooltip}
              content={
                <InfoTipCard
                  {...terminalHoverDetails(
                    { ...term, name: formatTerminalName(term.name) },
                    fullCreated,
                    translate,
                  )}
                />
              }
              anchorClosest="[data-terminal-session-row]"
              side="right"
              wrapperClassName="flex min-w-0"
            >
              <span
                className={`truncate text-ui ${
                  exited ? 'opacity-60' : awaitingRestore && !isActive ? 'text-fg-muted' : ''
                }`}
              >
                {formatTerminalName(term.name)}
              </span>
            </Tooltip>
          )}
        </div>
        {(term.status === 'reconnecting' || isPending) && !isRenaming && (
          <LoaderCircle
            size={14}
            aria-label={isPending ? translate('正在切换项目…') : translate('正在重新连接…')}
            className={`flex-shrink-0 animate-spin ${isPending ? 'text-fg-muted' : 'text-warn'}`}
          />
        )}
        {exited && !isRenaming && !managing && (
          <Tooltip label={translate(restartLabel, { exitCode: exitCodeSuffix })} side="top">
            <button
              type="button"
              aria-label={translate(restartLabel, { exitCode: '' })}
              className={`${ROW_BUTTON} hover:bg-bg-active`}
              onClick={event => {
                event.stopPropagation()
                void reloadTerminal(term)
              }}
            >
              <RotateCcw size={14} />
            </button>
          </Tooltip>
        )}
        {activityIndicator && (
          <TerminalActivityDot
            terminalId={term.id}
            exited={term.status === 'exited'}
            attention={attentionIds.has(term.id) && !isActive}
            awaitingRestore={awaitingRestore}
            size="md"
          />
        )}
        {/* 时间和关闭按钮共用一格：平时显示时间，悬停或键盘聚焦时换成关闭按钮。 */}
        <span className="relative flex h-6 min-w-6 flex-shrink-0 items-center justify-end">
          {trailing && (
            <span
              data-terminal-created={trailing === created ? term.id : undefined}
              className={`whitespace-nowrap pr-1 text-ui-xs text-fg-dim ${
                managing
                  ? ''
                  : isCloseArmed
                    ? 'invisible'
                    : 'group-hover:invisible group-has-[:focus-visible]:invisible'
              }`}
            >
              {trailing}
            </span>
          )}
          {!managing && (
            <Tooltip
              label={isCloseArmed ? translate('再次点击关闭终端') : translate('关闭终端')}
              side="top"
              forceOpen={isCloseArmed}
              wrapperClassName="absolute inset-y-0 right-0 inline-flex items-center"
            >
              <button
                type="button"
                aria-label={isCloseArmed ? translate('确认关闭终端') : translate('关闭终端')}
                data-terminal-close={term.id}
                className={`${ROW_BUTTON} ${
                  isCloseArmed
                    ? 'bg-danger/15 text-danger'
                    : 'opacity-0 hover:bg-bg-active focus-visible:opacity-100 group-hover:opacity-100'
                }`}
                onClick={event => handleCloseClick(event, term.id)}
              >
                {isCloseArmed ? <Circle size={10} fill="currentColor" /> : <X size={15} />}
              </button>
            </Tooltip>
          )}
        </span>
      </div>
    )
  }

  const renderGroup = (group: TerminalSessionGroup) => {
    const { project, terminals } = group
    const isCurrent = project.id === currentProjectId
    const isEmpty = terminals.length === 0
    const expanded = isExpanded(group)
    const source = projectSources.get(project.id)
    // 菜单打开后鼠标会离开组头，操作按钮要保持显示，菜单才有明确的来源。
    const actionsHeld = profileMenu?.projectId === project.id || projectMenu?.projectId === project.id
    const sortable = !managing && !project.hidden && projects.some(item => item.id === project.id)
    const hasAttention =
      activityIndicator && !expanded && terminals.some(term => attentionIds.has(term.id))
    const groupAtLimit = terminals.length >= MAX_TERMINALS_PER_PROJECT
    const pickedInGroup = terminals.filter(term => picked.has(term.id)).length
    const groupPick: PickState =
      pickedInGroup === 0 ? 'off' : pickedInGroup === terminals.length ? 'on' : 'mixed'
    return (
      <section
        key={project.id}
        role="group"
        aria-label={project.name}
        aria-current={isCurrent ? 'true' : undefined}
        data-terminal-project-group={project.id}
        className={`relative ${draggedProjectId === project.id ? 'opacity-45' : ''}`}
        onDragOver={event => onProjectDragOver(event, project.id)}
        onDrop={event => onProjectDrop(event, project.id)}
      >
        {projectDrop?.id === project.id && (
          <span
            aria-hidden="true"
            data-terminal-project-drop={projectDrop.position}
            className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-brand ${
              projectDrop.position === 'before' ? '-top-px' : '-bottom-px'
            }`}
          />
        )}
        <div
          data-terminal-project-header={project.id}
          draggable={sortable}
          onDragStart={event => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('application/x-qingcode-project', project.id)
            setDraggedProjectId(project.id)
            setProjectDrop(null)
          }}
          onDragEnd={clearProjectDrag}
          className={`group/project flex h-7 items-center gap-1 rounded-md pr-1 transition-colors ${
            isCurrent
              ? 'bg-brand/10 text-fg hover:bg-brand/15'
              : `text-fg-muted hover:bg-bg-hover ${isEmpty ? 'opacity-70 hover:opacity-100' : ''}`
          }`}
        >
          {managing && expanded && (
            <button
              type="button"
              role="checkbox"
              aria-checked={groupPick === 'mixed' ? 'mixed' : groupPick === 'on'}
              aria-label={translate('选择「{name}」的全部终端', { name: project.name })}
              className="ml-1 flex h-full flex-shrink-0 items-center"
              onClick={() => {
                const next = new Set(picked)
                for (const term of terminals) {
                  if (groupPick === 'on') next.delete(term.id)
                  else next.add(term.id)
                }
                setSelection(next)
              }}
            >
              <PickBox state={groupPick} data-terminal-group-pick={project.id} />
            </button>
          )}
          <button
            type="button"
            aria-expanded={isEmpty ? undefined : expanded}
            aria-label={translate('展开或收起「{name}」', { name: project.name })}
            // 不用 disabled：禁用按钮吃掉鼠标事件，空项目的组头就拖不动了。
            aria-disabled={isEmpty || undefined}
            tabIndex={isEmpty ? -1 : undefined}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded pl-1 text-left text-ui-sm aria-disabled:cursor-default"
            onClick={() => {
              if (!isEmpty) setProjectCollapsed(project.id, expanded)
            }}
          >
            <span
              aria-hidden="true"
              data-terminal-group-current={isCurrent ? 'true' : undefined}
              className={`flex flex-shrink-0 ${isCurrent ? 'text-brand' : ''}`}
            >
              <ProjectKindIcon project={project} open={expanded} size={14} />
            </span>
            <Tooltip
              label={projectChipTooltipLabel(project, sshConnections, translate)}
              content={<InfoTipCard {...projectHoverDetails(project, sshConnections, translate)} />}
              anchorClosest="[data-terminal-project-header]"
              side="right"
              wrapperClassName="flex min-w-0 flex-1 items-center gap-1.5"
            >
              {/* 项目名优先完整显示，来源只用剩余宽度。 */}
              <span className="block min-w-0 max-w-[70%] flex-none truncate font-medium">{project.name}</span>
              {source && (
                <span className="min-w-0 truncate rounded border border-border-strong px-1 py-px text-ui-badge leading-tight text-fg-dim">
                  {source}
                </span>
              )}
            </Tooltip>
          </button>
          {hasAttention && (
            <span
              role="img"
              aria-label={translate('「{name}」有新结果待查看', { name: project.name })}
              data-terminal-group-attention={project.id}
              className="h-2 w-2 flex-shrink-0 rounded-full bg-brand"
            />
          )}
          {!isEmpty && (
            <span
              role="img"
              aria-label={translate('{count} 个终端', { count: terminals.length })}
              data-terminal-group-count={project.id}
              className={`flex w-6 flex-shrink-0 items-center justify-center text-ui-xs text-fg-dim ${
                actionsHeld ? 'hidden' : 'group-hover/project:hidden group-has-[:focus-visible]/project:hidden'
              }`}
            >
              {terminals.length}
            </span>
          )}
          {/* 平时显示数量，悬停或键盘聚焦时换成操作按钮；空项目的切换按钮不可聚焦，靠 opacity 保持按钮可达。 */}
          <span
            data-terminal-group-actions={project.id}
            className={`flex-shrink-0 items-center ${
              isEmpty
                ? `flex ${actionsHeld ? '' : 'opacity-0 focus-within:opacity-100 group-hover/project:opacity-100'}`
                : actionsHeld
                  ? 'flex'
                  : 'hidden group-hover/project:flex group-has-[:focus-visible]/project:flex'
            }`}
          >
            <Tooltip label={translate('项目操作')} side="top">
              <button
                type="button"
                aria-label={translate('「{name}」的项目操作', { name: project.name })}
                aria-haspopup="menu"
                aria-expanded={projectMenu?.projectId === project.id}
                className={`${ROW_BUTTON} ${GROUP_ACTION}`}
                onClick={event => {
                  if (projectMenu?.projectId === project.id) {
                    setProjectMenu(null)
                    return
                  }
                  const rect = event.currentTarget.getBoundingClientRect()
                  setProjectMenu({ x: rect.left, y: rect.bottom + 4, projectId: project.id })
                }}
              >
                <MoreHorizontal size={15} />
              </button>
            </Tooltip>
            <Tooltip
              label={
                groupAtLimit
                  ? translate('已达到每个项目 {count} 个终端的上限', { count: MAX_TERMINALS_PER_PROJECT })
                  : translate('在「{name}」新建终端', { name: project.name })
              }
              side="top"
            >
              <button
                type="button"
                aria-label={translate('在「{name}」新建终端', { name: project.name })}
                disabled={groupAtLimit || creatingTerminal}
                className={`${ROW_BUTTON} ${GROUP_ACTION} disabled:cursor-not-allowed`}
                onClick={() => {
                  setProjectCollapsed(project.id, false)
                  handleNewTerminal(undefined, project.id)
                }}
                onContextMenu={event => {
                  if (creatingTerminal || !shouldShowAppContextMenu(event)) return
                  setProfileMenu({ x: event.clientX, y: event.clientY, projectId: project.id })
                }}
              >
                <Plus size={15} />
              </button>
            </Tooltip>
            <Tooltip label={translate('选择终端配置')} side="top">
              <button
                type="button"
                aria-label={translate('为「{name}」选择终端配置', { name: project.name })}
                aria-haspopup="menu"
                aria-expanded={profileMenu?.projectId === project.id}
                className={`flex ui-chip h-6 w-4 flex-shrink-0 items-center justify-center rounded ${GROUP_ACTION}`}
                onClick={event => {
                  if (profileMenu?.projectId === project.id) {
                    setProfileMenu(null)
                    return
                  }
                  const rect = event.currentTarget.getBoundingClientRect()
                  setProfileMenu({ x: rect.left, y: rect.bottom + 4, projectId: project.id })
                }}
              >
                <ChevronDown size={13} />
              </button>
            </Tooltip>
          </span>
        </div>
        {expanded && (
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label={project.name}
            className="mt-0.5 flex flex-col gap-0.5"
          >
            {terminals.map(renderRow)}
          </div>
        )}
      </section>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-sidebar"
      data-terminal-session-list
    >
      <div className="flex h-9 flex-shrink-0 items-center gap-0.5 pl-3 pr-1.5 text-ui-xs font-semibold tracking-wide text-fg-muted">
        <span className="min-w-0 flex-1 truncate">
          {translate('终端')}
          {totalTerminals > 0 && (
            <span className="ml-1.5 font-normal text-fg-dim">{totalTerminals}</span>
          )}
        </span>
        <Tooltip
          label={
            currentProject && atLimit
              ? translate('已达到每个项目 {count} 个终端的上限', { count: MAX_TERMINALS_PER_PROJECT })
              : currentProject
                ? translate('新建终端（默认配置）')
                : translate('新建终端（无项目时将创建草稿项目）')
          }
          side="bottom"
        >
          <button
            type="button"
            aria-label={translate('新建终端')}
            className={HEADER_BUTTON}
            disabled={newDisabled}
            onClick={() => {
              if (currentProjectId) setProjectCollapsed(currentProjectId, false)
              handleNewTerminal()
            }}
            onContextMenu={event => {
              if (creatingTerminal || !shouldShowAppContextMenu(event)) return
              setProfileMenu({ x: event.clientX, y: event.clientY })
            }}
          >
            {creatingTerminal ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
          </button>
        </Tooltip>
        <Tooltip label={translate('选择终端配置')} side="bottom">
          <button
            type="button"
            aria-label={translate('选择终端配置')}
            aria-haspopup="menu"
            aria-expanded={profileMenu !== null && !profileMenu.projectId}
            className="flex ui-chip h-6 w-4 flex-shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
            onClick={event => {
              if (profileMenu) {
                setProfileMenu(null)
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              setProfileMenu({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <ChevronDown size={12} />
          </button>
        </Tooltip>
        <span className="mx-0.5 h-4 w-px flex-shrink-0 bg-border" aria-hidden="true" />
        <Tooltip label={managing ? translate('完成') : translate('管理')} side="bottom">
          <button
            type="button"
            aria-label={managing ? translate('完成') : translate('管理')}
            aria-pressed={managing}
            className={`${HEADER_BUTTON} aria-pressed:bg-bg-active aria-pressed:text-fg`}
            disabled={totalTerminals === 0 && !managing}
            onClick={() => setManaging(!managing)}
          >
            {managing ? <Check size={15} /> : <ListChecks size={15} />}
          </button>
        </Tooltip>
        <Tooltip label={translate('收起终端（任务继续在后台运行）')} side="bottom">
          <button
            type="button"
            aria-label={translate('收起终端')}
            className={HEADER_BUTTON}
            onClick={() => requestToggleTerminal()}
          >
            <ChevronLeft size={15} />
          </button>
        </Tooltip>
      </div>

      {managing && (
        <div
          data-terminal-manage-bar
          className="flex flex-shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-border px-2.5 pb-1.5"
        >
          <span role="status" className="mr-auto text-ui-xs text-fg-dim">
            {translate('已选 {n}', { n: picked.size })}
          </span>
          <button
            type="button"
            className={BAR_BUTTON}
            disabled={closingBatch || visibleTerminals.length === 0}
            onClick={() =>
              setSelection(allPicked ? new Set() : new Set(visibleTerminals.map(term => term.id)))
            }
          >
            {allPicked ? translate('取消全选') : translate('全选 {n}', { n: visibleTerminals.length })}
          </button>
          <button
            type="button"
            className={BAR_BUTTON}
            disabled={closingBatch || endedVisible.length === 0}
            onClick={() => setSelection(new Set(endedVisible.map(term => term.id)))}
          >
            {translate('选已结束')}
          </button>
          <button
            type="button"
            className={`${BAR_BUTTON} text-danger hover:text-danger`}
            disabled={closingBatch || picked.size === 0}
            onClick={() => void closePicked()}
          >
            {translate('关闭所选')}
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState
          className="min-h-0 flex-1"
          icon={<TerminalIcon size={28} strokeWidth={1.2} />}
          title={translate('请先选择或添加项目，终端将默认基于当前项目创建')}
        />
      ) : (
        <div
          ref={listRef}
          className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-1.5 pb-1.5"
          onKeyDown={onListKeyDown}
        >
          {groups.map(renderGroup)}
          {totalTerminals === 0 && currentProject && (
            <EmptyState
              className="min-h-0 flex-1"
              icon={<TerminalIcon size={28} strokeWidth={1.2} />}
              title={translate('当前项目「{name}」暂无终端，点击上方 + 新建', { name: currentProject.name })}
            />
          )}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            ...menuItems(contextMenu.terminal),
            ...(managing
              ? []
              : [
                  {
                    label: translate('批量操作'),
                    icon: <ListChecks size={14} />,
                    separatorBefore: true,
                    action: () => {
                      setManageMode(true)
                      setSelection(new Set([contextMenu.terminal.id]))
                      setCloseArmId(null)
                    },
                  },
                ]),
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
      {projectMenu && (() => {
        const group = groups.find(item => item.project.id === projectMenu.projectId)
        if (!group) return null
        const expanded = isExpanded(group)
        return (
          <ContextMenu
            x={projectMenu.x}
            y={projectMenu.y}
            items={[
              {
                label: expanded ? translate('收起分组') : translate('展开分组'),
                icon: expanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />,
                disabled: group.terminals.length === 0,
                action: () => setProjectCollapsed(group.project.id, expanded),
              },
              {
                label: translate('关闭此项目的全部终端'),
                icon: <X size={14} />,
                danger: true,
                separatorBefore: true,
                disabled: group.terminals.length === 0,
                action: () => handleCloseAllInStrip(group.project.id),
              },
            ]}
            onClose={() => setProjectMenu(null)}
          />
        )
      })()}
      {profileMenu && (
        <ContextMenu
          x={profileMenu.x}
          y={profileMenu.y}
          items={profileMenuItems(profileMenu.projectId, () => {
            const targetId = profileMenu.projectId ?? currentProjectId
            if (targetId) setProjectCollapsed(targetId, false)
          })}
          onClose={() => setProfileMenu(null)}
        />
      )}
    </div>
  )
}
