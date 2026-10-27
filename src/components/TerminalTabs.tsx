import { useInterfaceMetrics } from '../hooks/useInterfaceMetrics'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  Circle,
  Plus,
  RotateCcw,
  X,
  Terminal as TerminalIcon,
  Pencil,
  XSquare,
  Files,
  List,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
} from 'lucide-react'
import {
  MAX_TERMINALS_PER_PROJECT,
  terminalPaneOf,
  useTerminalStore,
  type TerminalFocusPane,
} from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { confirmDialog } from '../store/confirmStore'
import { loadTerminalProfileSettings, getEffectiveDefaultProfileId } from '@/lib/terminal/terminalProfiles'
import { formatTerminalName } from '../utils/terminalName'
import { pickVisibleTabIndices } from '../lib/editorTabsLayout'

/** Width reserved for the new-terminal control next to the last tab. */
const TERMINAL_NEW_BTN_W = 32
/** Must match the strip's `gap-1` / `px-1.5` so overflow fitting counts spacing. */
const TERMINAL_TAB_GAP = 4
const TERMINAL_STRIP_PAD_X = 12
import {
  canCloseTerminalDirectly,
  listBusyTerminals,
  terminalCloseButtonAction,
} from '@/lib/terminal/terminalClose'
import { shouldKeepShellAfterExit } from '@/lib/terminal/terminalShellLifecycle'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import type { TerminalTab } from '../types'
import { useI18n } from '../lib/i18n'
import { terminalShellLabelKey } from '@/lib/terminal/terminalShell'
import { isSshResource } from '@/lib/tauri'

const CLOSE_ARM_MS = 4000
/** Exited tabs end with the restart button, which already carries its own hit area. */
function terminalTabPaddingClass(status: TerminalTab['status']): string {
  return status === 'exited' ? 'pl-0.5 pr-0.5' : 'pl-0.5 pr-2.5'
}

export default function TerminalTabs({
  /** When set, this tab strip owns one dual-terminal pane (independent header). */
  pane,
  /** Stronger chrome when this pane owns focus (outer ring is drawn by TerminalPanel). */
  focused = false,
  /** Panel chrome (collapse / close all). Only one strip should show these. */
  showPanelActions = true,
}: {
  pane?: TerminalFocusPane
  focused?: boolean
  showPanelActions?: boolean
} = {}) {
  const { t: translate } = useI18n()
  const { fontSize: interfaceFontSize } = useInterfaceMetrics()
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const secondaryTerminalId = useTerminalStore(s => s.secondaryTerminalId)
  const blTerminalId = useTerminalStore(s => s.blTerminalId)
  const brTerminalId = useTerminalStore(s => s.brTerminalId)
  const setTerminalFocusPane = useTerminalStore(s => s.setTerminalFocusPane)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)
  const reorderTerminal = useTerminalStore(s => s.reorderTerminal)
  const paneActiveId =
    pane === 'secondary'
      ? secondaryTerminalId
      : pane === 'bl'
        ? blTerminalId
        : pane === 'br'
          ? brTerminalId
          : activeTerminalId
  const activateForPane = (id: string) => {
    setTerminalFocusPane(pane ?? 'primary')
    setActiveTerminal(id)
  }
  const closeTerminal = useTerminalStore(s => s.closeTerminal)
  const closeOtherTerminals = useTerminalStore(s => s.closeOtherTerminals)
  const closeAllProjectTerminals = useTerminalStore(s => s.closeAllProjectTerminals)
  const restartTerminal = useTerminalStore(s => s.restartTerminal)
  const renameTerminal = useTerminalStore(s => s.renameTerminal)
  const addTerminal = useTerminalStore(s => s.addTerminal)
  const currentProject = useProjectStore(s => s.currentProject)
  const addEmptyProject = useProjectStore(s => s.addEmptyProject)
  const switchProject = useProjectStore(s => s.switchProject)
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)
  const panelLayout = useUIStore(s => s.panelLayout)
  const collapseToSide = panelLayout === 'sideTerminal'
  const [creatingTerminal, setCreatingTerminal] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    terminal: TerminalTab
  } | null>(null)
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number } | null>(null)
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null)
  const [closeArmId, setCloseArmId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [visibleIndices, setVisibleIndices] = useState<number[]>([])
  const [draggedTerminalId, setDraggedTerminalId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameCommittingRef = useRef(false)
  /** Flex area that holds visible tabs + the trailing `+` (like project chips). */
  const tabsAreaRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)

  const allProjectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  // Dual/田: each pane strip only manages sessions it owns. Classic: show all.
  const projectTerminals = pane
    ? allProjectTerminals.filter(t => terminalPaneOf(t) === pane)
    : allProjectTerminals
  const atLimit = allProjectTerminals.length >= MAX_TERMINALS_PER_PROJECT
  // Stable deps for overflow measure (avoid new-array identity loops).
  const projectTerminalMeasureKey = projectTerminals
    .map(term => `${term.id}:${term.name}:${term.status}`)
    .join('|')

  useLayoutEffect(() => {
    const area = tabsAreaRef.current
    const measure = measureRef.current
    const count = projectTerminals.length
    if (!area || !measure || count === 0) {
      setVisibleIndices(prev => (prev.length === 0 ? prev : []))
      return
    }

    const compute = () => {
      // 每个标签宽度连同其后的间距一起计；末尾多算的一个间距在 available 里补回。
      const widths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-tab-measure-id]'),
        el => el.offsetWidth + TERMINAL_TAB_GAP,
      )
      // Overflow / panel actions sit outside `tabsArea`; only reserve the `+` width.
      const available = Math.max(
        0,
        area.clientWidth - TERMINAL_NEW_BTN_W - TERMINAL_STRIP_PAD_X + TERMINAL_TAB_GAP,
      )
      const next =
        widths.length !== count
          ? Array.from({ length: count }, (_, i) => i)
          : pickVisibleTabIndices(
              widths,
              Math.max(
                0,
                projectTerminals.findIndex(term => term.id === paneActiveId),
              ),
              available,
              0,
            )
      setVisibleIndices(prev =>
        prev.length === next.length && prev.every((value, i) => value === next[i])
          ? prev
          : next,
      )
    }

    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(area)
    measure.querySelectorAll<HTMLElement>('[data-tab-measure-id]').forEach(el => ro.observe(el))
    return () => ro.disconnect()
  }, [projectTerminalMeasureKey, paneActiveId, renamingId, renameDraft, interfaceFontSize])

  useEffect(() => {
    if (!renamingId) return
    const timer = window.setTimeout(() => {
      const input = renameInputRef.current
      input?.focus()
      input?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [renamingId])

  useEffect(() => {
    if (!closeArmId) return
    const armed = terminals.find(t => t.id === closeArmId)
    if (!armed || armed.status === 'exited') setCloseArmId(null)
  }, [closeArmId, terminals])

  useEffect(() => {
    if (!closeArmId) return
    const timer = window.setTimeout(() => setCloseArmId(null), CLOSE_ARM_MS)
    return () => window.clearTimeout(timer)
  }, [closeArmId])

  useEffect(() => {
    if (!closeArmId) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element
      if (target.closest(`[data-terminal-close="${closeArmId}"]`)) return
      setCloseArmId(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [closeArmId])

  const handleCloseTab = async (id: string) => {
    setCloseArmId(null)
    await closeTerminal(id)
  }

  const handleCloseClick = (event: ReactMouseEvent, id: string) => {
    event.stopPropagation()
    const terminal = terminals.find(t => t.id === id)
    const action = terminalCloseButtonAction(terminal?.status, closeArmId === id)
    if (action === 'close') {
      void handleCloseTab(id)
      return
    }
    if (action !== 'arm') return
    if (pane) setTerminalFocusPane(pane)
    setActiveTerminal(id)
    setCloseArmId(id)
  }

  const handleClose = async (id: string) => {
    const terminal = terminals.find(tab => tab.id === id)
    if (!terminal) return
    if (!(await canCloseTerminalDirectly(terminal))) {
      const confirmed = await confirmDialog({
        title: translate('关闭终端'),
        message: translate('「{name}」仍在运行', { name: formatTerminalName(terminal.name) }),
        detail: translate('关闭后将终止当前 shell 进程，会话中的未保存输出会丢失。'),
        kind: 'warning',
        confirmLabel: translate('终止并关闭'),
        cancelLabel: translate('取消'),
      })
      if (!confirmed) return
    }
    await closeTerminal(id)
  }

  const handleCloseOthers = async (id: string) => {
    const terminal = terminals.find(tab => tab.id === id)
    if (!terminal) return
    const homePane = terminalPaneOf(terminal)
    const runningOthers = await listBusyTerminals(
      terminals.filter(
        t =>
          t.projectId === terminal.projectId &&
          t.id !== id &&
          terminalPaneOf(t) === homePane,
      ),
    )
    if (runningOthers.length > 0) {
      const confirmed = await confirmDialog({
        title: translate('关闭其它终端'),
        message: translate('将终止 {count} 个运行中的终端', { count: runningOthers.length }),
        detail: translate('关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。'),
        kind: 'warning',
        confirmLabel: translate('终止并关闭'),
        cancelLabel: translate('取消'),
      })
      if (!confirmed) return
    }
    await closeOtherTerminals(id)
  }

  /** Context menu: close sessions owned by this pane (or all in classic mode). */
  const handleCloseAllInStrip = async () => {
    if (!currentProject) return
    const targets = pane ? projectTerminals : allProjectTerminals
    const running = await listBusyTerminals(targets)
    if (running.length > 0) {
      const confirmed = await confirmDialog({
        title: translate('关闭全部终端'),
        message: pane
          ? translate('将终止本窗格的 {count} 个运行中终端', { count: running.length })
          : translate('将终止当前项目的 {count} 个运行中终端', { count: running.length }),
        detail: translate('关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。'),
        kind: 'warning',
        confirmLabel: translate('终止并关闭'),
        cancelLabel: translate('取消'),
      })
      if (!confirmed) return
    }
    if (pane) {
      for (const term of [...targets]) {
        await closeTerminal(term.id)
      }
      return
    }
    await closeAllProjectTerminals(currentProject.id)
  }

  /** Panel chrome: always close every terminal in the project. */
  const handleCloseAllProject = async () => {
    if (!currentProject) return
    const running = await listBusyTerminals(allProjectTerminals)
    if (running.length > 0) {
      const confirmed = await confirmDialog({
        title: translate('关闭全部终端'),
        message: translate('将终止当前项目的 {count} 个运行中终端', {
          count: running.length,
        }),
        detail: translate('关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。'),
        kind: 'warning',
        confirmLabel: translate('终止并关闭'),
        cancelLabel: translate('取消'),
      })
      if (!confirmed) return
    }
    await closeAllProjectTerminals(currentProject.id)
  }

  const startRename = (id: string, currentName: string) => {
    setCloseArmId(null)
    if (pane) setTerminalFocusPane(pane)
    setActiveTerminal(id)
    setRenamingId(id)
    setRenameDraft(currentName)
  }

  const commitRename = (id: string) => {
    renameCommittingRef.current = true
    const trimmed = renameDraft.trim()
    if (trimmed) renameTerminal(id, trimmed)
    setRenamingId(null)
    setRenameDraft('')
    window.setTimeout(() => {
      renameCommittingRef.current = false
    }, 0)
  }

  const cancelRename = () => {
    setRenamingId(null)
    setRenameDraft('')
  }

  const ensureProjectForTerminal = async () => {
    const state = useProjectStore.getState()
    if (state.currentProject) return state.currentProject

    // Prefer an already-listed project (e.g. empty/ephemeral chip in the title bar)
    // before creating another scratch workspace.
    const candidate =
      state.projects.find(
        (project) => !project.hidden && !state.unavailableProjectIds.includes(project.id),
      ) ?? state.projects.find((project) => !project.hidden)

    if (candidate) {
      const switched = await switchProject(candidate)
      return switched ? useProjectStore.getState().currentProject : null
    }

    const created = await addEmptyProject()
    return created ? useProjectStore.getState().currentProject : null
  }

  const handleNewTerminal = (profileId?: string) => {
    if (creatingTerminal) return
    if (currentProject && atLimit) {
      useProjectStore.getState().pushToast(
        'info',
        translate('已达到每个项目 {count} 个终端的上限', { count: MAX_TERMINALS_PER_PROJECT })
      )
      return
    }

    setCreatingTerminal(true)
    void (async () => {
      try {
        if (pane) setTerminalFocusPane(pane)
        const project = currentProject ?? (await ensureProjectForTerminal())
        if (!project) {
          useProjectStore
            .getState()
            .pushToast('info', translate('请先选择或添加项目，再创建终端'))
          return
        }
        const sameProject = useTerminalStore
          .getState()
          .terminals.filter((terminal) => terminal.projectId === project.id)
        if (sameProject.length >= MAX_TERMINALS_PER_PROJECT) {
          useProjectStore.getState().pushToast(
            'info',
            translate('已达到每个项目 {count} 个终端的上限', {
              count: MAX_TERMINALS_PER_PROJECT,
            }),
          )
          return
        }
        // Re-assert pane ownership right before create (async gap may have moved focus).
        if (pane) setTerminalFocusPane(pane)
        await addTerminal(project.path, project.id, profileId)
      } finally {
        setCreatingTerminal(false)
      }
    })()
  }

  const profileMenuItems = (): ContextMenuItem[] => {
    const settings = loadTerminalProfileSettings()
    const effectiveDefaultId = getEffectiveDefaultProfileId(settings)
    return settings.profiles.map(profile => ({
      label:
        profile.id === effectiveDefaultId
          ? `${profile.name.trim() || translate('未命名配置')}${translate('（默认）')}`
          : profile.name.trim() || translate('未命名配置'),
      icon: <Plus size={14} />,
      disabled: atLimit,
      action: () => handleNewTerminal(profile.id),
    }))
  }

  const overflowItems = (): ContextMenuItem[] =>
    projectTerminals.map(term => ({
      label: term.id === paneActiveId ? `${formatTerminalName(term.name)} ●` : formatTerminalName(term.name),
      action: () => activateForPane(term.id),
    }))

  const visibleTabIndices =
    visibleIndices.length > 0
      ? visibleIndices
      : projectTerminals.map((_, i) => i)
  const hiddenCount = Math.max(0, projectTerminals.length - visibleTabIndices.length)

  useEffect(() => {
    if (hiddenCount === 0) setOverflowMenu(null)
  }, [hiddenCount])

  const clearTerminalDrag = () => {
    setDraggedTerminalId(null)
    setDropTarget(null)
  }

  const handleTabDragStart = (event: ReactDragEvent<HTMLDivElement>, id: string) => {
    if ((event.target as Element).closest('button, input')) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    setDraggedTerminalId(id)
    setDropTarget(null)
  }

  const handleTabDragOver = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    const sourceId = draggedTerminalId || event.dataTransfer.getData('text/plain')
    if (!sourceId || sourceId === targetId) {
      setDropTarget(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    setDropTarget(current =>
      current?.id === targetId && current.position === position
        ? current
        : { id: targetId, position },
    )
  }

  const handleTabDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    const sourceId = draggedTerminalId || event.dataTransfer.getData('text/plain')
    if (sourceId && sourceId !== targetId) {
      const rect = event.currentTarget.getBoundingClientRect()
      const position = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
      reorderTerminal(sourceId, targetId, position)
    }
    clearTerminalDrag()
  }

  const menuItems = (terminal: TerminalTab): ContextMenuItem[] => [
    {
      label: translate('重命名'),
      icon: <Pencil size={14} />,
      action: () => {
        startRename(terminal.id, terminal.name)
        setContextMenu(null)
      },
    },
    {
      label: translate('重新加载'),
      icon: <RotateCcw size={14} />,
      action: () => {
        void restartTerminal(terminal.id)
      },
    },
    {
      label: translate('新建终端（默认配置）'),
      icon: <Plus size={14} />,
      disabled: atLimit,
      action: () => handleNewTerminal(),
    },
    {
      label: translate('关闭'),
      icon: <X size={14} />,
      separatorBefore: true,
      action: () => handleClose(terminal.id),
    },
    {
      label: translate('关闭其它'),
      icon: <XSquare size={14} />,
      action: () => handleCloseOthers(terminal.id),
    },
    {
      label: translate('关闭全部'),
      icon: <Files size={14} />,
      action: handleCloseAllInStrip,
    },
  ]

  return (
    <>
    <div
      className={`ui-font-scaled relative flex h-[var(--tab-height)] flex-shrink-0 items-center border-b border-border bg-bg-deep ${
        focused ? 'bg-bg-active/40' : ''
      }`}
      data-terminal-pane-focused={focused ? 'true' : undefined}
    >
        <div
          className={`flex h-full flex-shrink-0 items-center gap-1.5 border-r border-border px-3 text-ui-xs font-semibold tracking-wide ${
            focused ? 'text-brand' : 'text-fg-muted'
          }`}
          onPointerDown={() => {
            if (pane) setTerminalFocusPane(pane)
          }}
        >
          <TerminalIcon size={13} />{' '}
          {translate('终端')}
        </div>
        {/* Tabs + `+` hug content on the left (same pattern as project chips). */}
        <div
          ref={tabsAreaRef}
          className="flex h-full min-w-0 flex-1 items-center overflow-hidden"
          onPointerDown={() => {
            if (pane) setTerminalFocusPane(pane)
          }}
        >
          <div
            ref={stripRef}
            role="tablist"
            aria-label={
              pane === 'bl'
                ? translate('终端 - 左下')
                : pane === 'br'
                  ? translate('终端 - 右下')
                  : pane === 'secondary'
                    ? translate('终端 - 次窗格')
                    : translate('终端')
            }
            className="flex h-full min-w-0 shrink items-center gap-1 overflow-hidden px-1.5"
            onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              if (visibleTabIndices.length === 0) return
              const current = visibleTabIndices.findIndex(
                i => projectTerminals[i]?.id === paneActiveId,
              )
              if (current < 0) return
              event.preventDefault()
              const delta = event.key === 'ArrowRight' ? 1 : -1
              const nextIndex =
                visibleTabIndices[
                  (current + delta + visibleTabIndices.length) % visibleTabIndices.length
                ]
              const next = nextIndex != null ? projectTerminals[nextIndex] : undefined
              if (next) activateForPane(next.id)
            }}
          >
            {visibleTabIndices.map(index => {
              const t = projectTerminals[index]
              if (!t) return null
              const isCloseArmed = closeArmId === t.id
              const isActive = t.id === paneActiveId
              const persistentWarning =
                isSshResource(t.cwd) &&
                t.persistent !== true &&
                t.status !== 'starting'
              const tooltipLines = [
                t.launchCommand.trim() && t.launchCommand.trim() !== t.name
                  ? `${t.name}\n> ${t.launchCommand.trim()}`
                  : t.name,
                t.resolvedShell
                  ? `${translate('Shell')}: ${translate(terminalShellLabelKey(t.resolvedShell))}`
                  : null,
                t.status === 'reconnecting'
                  ? translate('正在重新连接…')
                  : null,
                persistentWarning ? translate('此终端断线会结束远端进程') : null,
                persistentWarning && t.persistentFallbackReason
                  ? translate('未能持久化：{reason}', {
                      reason: t.persistentFallbackReason,
                    })
                  : persistentWarning && t.disconnectReason
                    ? translate('断开原因：{reason}', { reason: t.disconnectReason })
                    : null,
              ].filter((line): line is string => line !== null).join('\n')
              return (
                <div
                  key={t.id}
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  draggable={renamingId !== t.id}
                  className={`group relative flex ui-chip h-6 flex-shrink-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap rounded ${terminalTabPaddingClass(t.status)} text-ui transition-colors
                    ${isActive ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'}
                    ${draggedTerminalId === t.id ? 'opacity-45' : ''}`}
                  onDragStart={event => handleTabDragStart(event, t.id)}
                  onDragOver={event => handleTabDragOver(event, t.id)}
                  onDrop={event => handleTabDrop(event, t.id)}
                  onDragEnd={clearTerminalDrag}
                  onClick={() => {
                    activateForPane(t.id)
                    if (closeArmId && closeArmId !== t.id) setCloseArmId(null)
                  }}
                  onKeyDown={event => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      activateForPane(t.id)
                    }
                  }}
                  onDoubleClick={event => {
                    // Close / restart buttons sit inside the tab; their dblclick
                    // must not start rename (common when double-clicking ×).
                    if (
                      (event.target as Element | null)?.closest?.(
                        'button, input, [data-terminal-close]',
                      )
                    ) {
                      return
                    }
                    event.preventDefault()
                    startRename(t.id, t.name)
                  }}
                  onContextMenu={(event: ReactMouseEvent) => {
                    if (!shouldShowAppContextMenu(event)) return
                    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
                    setContextMenu({ x: event.clientX, y: event.clientY, terminal: t })
                  }}
                >
                  {dropTarget?.id === t.id && draggedTerminalId !== t.id && (
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute bottom-0.5 top-0.5 z-10 w-0.5 rounded bg-brand ${
                        dropTarget.position === 'before' ? '-left-0.5' : '-right-0.5'
                      }`}
                    />
                  )}
                  {isActive && (
                    <span
                      className="pointer-events-none absolute inset-x-1 bottom-0 h-[2px] rounded bg-brand"
                      aria-hidden="true"
                    />
                  )}
                  <Tooltip
                    label={isCloseArmed ? translate('再次点击关闭终端') : translate('关闭终端')}
                    side="top"
                    forceOpen={isCloseArmed}
                  >
                    <button
                      type="button"
                      aria-label={isCloseArmed ? translate('确认关闭终端') : translate('关闭终端')}
                      data-terminal-close={t.id}
                      className={`flex items-center justify-center w-5 ui-chip h-6 rounded transition-colors ${
                        isCloseArmed
                          ? 'bg-danger/15 text-danger'
                          : 'hover:bg-bg-active'
                      }`}
                      onClick={e => handleCloseClick(e, t.id)}
                      onDoubleClick={e => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                    >
                      {isCloseArmed ? (
                        <Circle size={9} fill="currentColor" />
                      ) : (
                        <X size={13} className="opacity-60 group-hover:opacity-100" />
                      )}
                    </button>
                  </Tooltip>
                  {renamingId === t.id ? (
                    <>
                      <input
                        ref={renameInputRef}
                        type="text"
                        value={renameDraft}
                        onClick={event => event.stopPropagation()}
                        onChange={event => setRenameDraft(event.target.value)}
                        onKeyDown={event => {
                          event.stopPropagation()
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            commitRename(t.id)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelRename()
                          }
                        }}
                        onBlur={() => {
                          window.setTimeout(() => {
                            if (!renameCommittingRef.current && renamingId === t.id) {
                              commitRename(t.id)
                            }
                          }, 80)
                        }}
                        className="min-w-[5rem] max-w-[14rem] h-[var(--ui-chip-height)] px-1.5 text-ui bg-bg border border-accent rounded-sm outline-none text-fg"
                        aria-label={translate('重命名终端')}
                      />
                    </>
                  ) : (
                    <Tooltip
                      label={tooltipLines}
                      side="top"
                      wrapperClassName="flex items-center gap-1.5 min-w-0 max-w-[12rem]"
                    >
                      <span className={`text-ui truncate ${t.status === 'exited' ? 'opacity-60' : ''}`}>
                        {formatTerminalName(t.name)}
                      </span>
                    </Tooltip>
                  )}
                  {t.status === 'reconnecting' && renamingId !== t.id && (
                    <Tooltip
                      label={translate('正在重新连接…')}
                      side="top"
                    >
                      <LoaderCircle
                        size={12}
                        aria-label={translate('正在重新连接…')}
                        className="flex-shrink-0 animate-spin text-warn"
                      />
                    </Tooltip>
                  )}
                  {t.status === 'exited' && renamingId !== t.id && (
                    <Tooltip
                      label={
                        !shouldKeepShellAfterExit(t)
                          ? translate('按原运行配置重启{exitCode}', {
                              exitCode:
                                t.exitCode === null
                                  ? ''
                                  : translate('（退出码 {code}）', { code: t.exitCode }),
                            })
                          : translate('重启终端{exitCode}', {
                              exitCode:
                                t.exitCode === null
                                  ? ''
                                  : translate('（退出码 {code}）', { code: t.exitCode }),
                            })
                      }
                      side="top"
                    >
                      <button
                        type="button"
                        aria-label={
                          !shouldKeepShellAfterExit(t)
                            ? translate('按原运行配置重启{exitCode}', { exitCode: '' })
                            : translate('重启终端{exitCode}', { exitCode: '' })
                        }
                        className="flex items-center justify-center w-5 ui-chip h-6 rounded hover:bg-bg-active"
                        onClick={e => {
                          e.stopPropagation()
                          restartTerminal(t.id)
                        }}
                        onDoubleClick={e => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                      >
                        <RotateCcw size={12} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              )
            })}
          </div>
          <Tooltip
            label={
              currentProject && atLimit
                ? translate('已达到每个项目 {count} 个终端的上限', { count: MAX_TERMINALS_PER_PROJECT })
                : currentProject
                  ? translate('左键：默认配置；右键：选择终端配置')
                  : translate('新建终端（无项目时将创建临时项目）')
            }
            side="top"
            wrapperClassName="inline-flex h-full shrink-0 items-center"
          >
            <button
              type="button"
              aria-label={translate('新建终端')}
              className={`flex ui-chip h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors ${
                !(currentProject && atLimit) && !creatingTerminal
                  ? 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  : 'text-fg-dim cursor-not-allowed'
              }`}
              disabled={Boolean(currentProject && atLimit) || creatingTerminal}
              onClick={() => handleNewTerminal()}
              onContextMenu={event => {
                if (!currentProject || atLimit || creatingTerminal) return
                if (!shouldShowAppContextMenu(event)) return
                setProfileMenu({ x: event.clientX, y: event.clientY })
              }}
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        </div>
        {hiddenCount > 0 && (
          <Tooltip
            label={translate('显示所有终端（{hidden} 个已隐藏）', { hidden: hiddenCount })}
            side="top"
            wrapperClassName="inline-flex h-full shrink-0 items-center"
          >
            <button
              type="button"
              aria-label={translate('显示所有终端')}
              aria-haspopup="menu"
              aria-expanded={overflowMenu !== null}
              className="relative flex ui-chip h-6 w-7 flex-shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
              onPointerDown={() => {
                if (pane) setTerminalFocusPane(pane)
              }}
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                setOverflowMenu({ x: rect.right - 220, y: rect.bottom + 2 })
              }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-1/2 h-[80%] w-px -translate-y-1/2 bg-border-strong"
              />
              <List size={15} />
              <span className="absolute bottom-0.5 right-0.5 min-w-[12px] h-[12px] rounded-sm bg-action px-0.5 text-center text-[9px] font-semibold leading-[12px] text-on-action">
                {hiddenCount > 99 ? '99+' : hiddenCount}
              </span>
            </button>
          </Tooltip>
        )}
        {showPanelActions && (
          <div className="flex h-full flex-shrink-0 items-center gap-0.5 border-l border-border pr-1.5 pl-1">
            <Tooltip label={translate('收起终端（任务继续在后台运行）')} side="top">
              <button
                type="button"
                aria-label={translate('收起终端')}
                className="flex ui-chip h-6 w-7 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
                onClick={() => requestToggleTerminal()}
              >
                {collapseToSide ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              </button>
            </Tooltip>
            <Tooltip label={translate('关闭全部终端')} side="top">
              <button
                type="button"
                aria-label={translate('关闭全部终端')}
                disabled={allProjectTerminals.length === 0}
                className="flex ui-chip h-6 w-7 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => void handleCloseAllProject()}
              >
                <X size={15} />
              </button>
            </Tooltip>
          </div>
        )}
        {/* Hidden measure layer: natural tab widths for overflow fitting. */}
        <div
          ref={measureRef}
          className="pointer-events-none absolute left-0 top-0 -z-10 flex h-[var(--tab-height)] opacity-0"
          aria-hidden="true"
        >
          {projectTerminals.map(term => (
            <div
              key={`measure-${term.id}`}
              data-tab-measure-id={term.id}
              className={`flex ui-chip h-6 items-center gap-1 whitespace-nowrap rounded ${terminalTabPaddingClass(term.status)}`}
            >
              <span className="ui-chip h-6 w-5 flex-shrink-0" />
              <span className="max-w-[12rem] truncate text-ui">{formatTerminalName(term.name)}</span>
              {term.status === 'reconnecting' && (
                <span className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              )}
              {term.status === 'exited' && <span className="ui-chip h-6 w-5 flex-shrink-0" />}
            </div>
          ))}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu.terminal)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {profileMenu && (
        <ContextMenu
          x={profileMenu.x}
          y={profileMenu.y}
          items={profileMenuItems()}
          onClose={() => setProfileMenu(null)}
        />
      )}
      {overflowMenu && (
        <ContextMenu
          x={overflowMenu.x}
          y={overflowMenu.y}
          items={overflowItems()}
          onClose={() => setOverflowMenu(null)}
        />
      )}
    </>
  )
}
