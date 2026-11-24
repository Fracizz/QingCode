import { useInterfaceMetrics } from '../hooks/useInterfaceMetrics'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  Circle,
  Plus,
  RotateCcw,
  X,
  Terminal as TerminalIcon,
  List,
  ListTree,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Zap,
} from 'lucide-react'
import { MAX_TERMINALS_PER_PROJECT, useTerminalStore, type TerminalFocusPane } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { useTerminalTabActions } from '../hooks/useTerminalTabActions'
import { formatTerminalName } from '../utils/terminalName'
import { pickVisibleTabIndices } from '../lib/editorTabsLayout'
import { terminalPositionForTemplate } from '../lib/panelLayoutTemplate'

/** Width reserved for the new-terminal control next to the last tab. */
const TERMINAL_NEW_BTN_W = 52
/** Must match the strip's `gap-1` / `px-1.5` so overflow fitting counts spacing. */
const TERMINAL_TAB_GAP = 4
const TERMINAL_STRIP_PAD_X = 12
import { shouldKeepShellAfterExit } from '@/lib/terminal/terminalShellLifecycle'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import TerminalActivityDot from './TerminalActivityDot'
import TerminalRenameInput from './TerminalRenameInput'
import {
  getTerminalActivityIndicator,
  subscribeTerminalActivityIndicator,
} from '@/lib/terminal/terminalActivitySettings'
import { terminalTabTooltip } from '@/lib/terminal/terminalTabPresentation'
import { showsPrewarmHit, showsPrewarmPending } from '@/lib/terminal/prewarmIndicator'
import type { TerminalTab } from '../types'
import { useI18n } from '../lib/i18n'

/** Exited tabs end with the restart button, which already carries its own hit area. */
function terminalTabPaddingClass(status: TerminalTab['status']): string {
  return status === 'exited' ? 'pl-0.5 pr-0.5' : 'pl-0.5 pr-2.5'
}

function TerminalPaneHeader({
  children,
  focused = false,
  compact = false,
  onTitlePointerDown,
}: {
  children?: ReactNode
  focused?: boolean
  /** 多格终端：每格都有标签栏，格首只留图标，不再重复「终端」字样。 */
  compact?: boolean
  onTitlePointerDown?: () => void
}) {
  const { t } = useI18n()
  return (
    <div
      className={`ui-font-scaled relative flex h-[var(--tab-height)] flex-shrink-0 items-center border-b border-border bg-bg-deep ${
        focused ? 'bg-bg-active/40' : ''
      }`}
      data-terminal-pane-focused={focused ? 'true' : undefined}
    >
      <div
        data-terminal-pane-title=""
        className={`flex h-full flex-shrink-0 items-center gap-1.5 border-r border-border text-ui-xs font-semibold tracking-wide ${
          compact ? 'px-2.5' : 'px-3'
        } ${focused ? 'text-fg' : 'text-fg-muted'}`}
        onPointerDown={onTitlePointerDown}
      >
        <TerminalIcon size={14} />
        {!compact && t('终端')}
      </div>
      {children}
    </div>
  )
}

/** 预留中的加载指示延迟显示，命中通常很快，避免一闪而过。 */
const PREWARM_PENDING_DELAY_MS = 300

/** 预热状态是否需要在标题旁占位（命中图标或接管中的加载指示）。 */
function hasPrewarmIndicator(terminal: PrewarmIndicatorView): boolean {
  return showsPrewarmHit(terminal) || showsPrewarmPending(terminal)
}

type PrewarmIndicatorView = Pick<TerminalTab, 'prewarm' | 'launchCommand'>

function TerminalPrewarmIndicator({ terminal }: { terminal: PrewarmIndicatorView }) {
  const { t } = useI18n()
  const reserved = showsPrewarmPending(terminal)
  const [pendingVisible, setPendingVisible] = useState(false)
  useEffect(() => {
    if (!reserved) return
    const timer = window.setTimeout(() => setPendingVisible(true), PREWARM_PENDING_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
      setPendingVisible(false)
    }
  }, [reserved])

  if (showsPrewarmHit(terminal)) {
    return (
      <Tooltip label={t('已领取预热终端')} side="top" wrapperClassName="inline-flex shrink-0">
        <span role="img" aria-label={t('已领取预热终端')} data-terminal-prewarm="" className="inline-flex text-brand">
          <Zap size={12} aria-hidden="true" />
        </span>
      </Tooltip>
    )
  }
  if (reserved && pendingVisible) {
    return (
      <Tooltip label={t('正在接管预热终端…')} side="top" wrapperClassName="inline-flex shrink-0">
        <LoaderCircle
          size={12}
          aria-label={t('正在接管预热终端…')}
          data-terminal-prewarm-pending=""
          className="shrink-0 animate-spin text-fg-muted"
        />
      </Tooltip>
    )
  }
  return null
}

export function TerminalSessionHeader({ terminal }: { terminal?: Pick<TerminalTab, 'name' | 'prewarm' | 'launchCommand'> }) {
  return (
    <TerminalPaneHeader>
      {terminal?.name && (
        // 名称与状态图标按文字基线对齐（图标底边落在基线上），整组再在头部内垂直居中。
        <div className="flex min-w-0 items-baseline gap-1.5 overflow-hidden px-2">
          <span className="min-w-0 truncate text-ui text-fg">{formatTerminalName(terminal.name)}</span>
          <TerminalPrewarmIndicator terminal={terminal} />
        </div>
      )}
    </TerminalPaneHeader>
  )
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
  const {
    activateForPane,
    setTerminalFocusPane,
    paneActiveId,
    currentProject,
    allProjectTerminals,
    projectTerminals,
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
    handleCloseAllProject,
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
    restartTerminal,
  } = useTerminalTabActions({ pane })
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)
  const panelLayout = useUIStore(s => s.panelLayout)
  // 面板收起方向跟随终端所在位置：工作台终端在中列，向左收。
  const collapseIcon =
    panelLayout === 'terminalWorkbench' ? (
      <ChevronLeft size={16} />
    ) : terminalPositionForTemplate(panelLayout) === 'side' ? (
      <ChevronRight size={16} />
    ) : (
      <ChevronDown size={16} />
    )
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null)
  const activityIndicator = useSyncExternalStore(
    subscribeTerminalActivityIndicator,
    getTerminalActivityIndicator,
  )
  const [visibleIndices, setVisibleIndices] = useState<number[]>([])
  /** Flex area that holds visible tabs + the trailing `+` (like project chips). */
  const tabsAreaRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)

  // Stable deps for overflow measure (avoid new-array identity loops).
  const projectTerminalMeasureKey = projectTerminals
    .map(term => `${term.id}:${term.name}:${term.status}:${showsPrewarmHit(term)}`)
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

  const overflowItems = (): ContextMenuItem[] => [
    ...projectTerminals.map(term => ({
      label: term.id === paneActiveId ? `${formatTerminalName(term.name)} ●` : formatTerminalName(term.name),
      action: () => activateForPane(term.id),
    })),
    {
      label: translate('终端管理（全部项目与手机）'),
      icon: <ListTree size={14} />,
      separatorBefore: true,
      action: () => useUIStore.getState().openTerminalManager(),
    },
  ]

  const visibleTabIndices =
    visibleIndices.length > 0
      ? visibleIndices
      : projectTerminals.map((_, i) => i)
  const hiddenCount = Math.max(0, projectTerminals.length - visibleTabIndices.length)

  useEffect(() => {
    if (hiddenCount === 0) setOverflowMenu(null)
  }, [hiddenCount])

  return (
    <>
      <TerminalPaneHeader
        focused={focused}
        compact={Boolean(pane)}
        onTitlePointerDown={pane ? () => setTerminalFocusPane(pane) : undefined}
      >
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
              const showPrewarm = showsPrewarmHit(t) && renamingId !== t.id
              const tooltipLines = terminalTabTooltip(t, translate)
              return (
                <div
                  key={t.id}
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  draggable={renamingId !== t.id}
                  className={`group relative flex ui-chip h-6 cursor-pointer select-none items-center gap-1 whitespace-nowrap rounded ${terminalTabPaddingClass(t.status)} text-ui transition-colors
                    ${showPrewarm && visibleTabIndices.length === 1 ? 'min-w-0 shrink' : 'shrink-0'}
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
                      className={`flex shrink-0 items-center justify-center w-5 ui-chip ui-chip-compact h-6 rounded transition-colors ${
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
                        <X size={14} className="opacity-60 group-hover:opacity-100" />
                      )}
                    </button>
                  </Tooltip>
                  {/* 名称与状态图标按文字基线对齐，整组在标签内垂直居中。 */}
                  <span className="flex min-w-0 items-baseline gap-1">
                    {renamingId === t.id ? (
                      <TerminalRenameInput
                        terminalId={t.id}
                        draft={renameDraft}
                        inputRef={renameInputRef}
                        committingRef={renameCommittingRef}
                        onDraftChange={setRenameDraft}
                        onCommit={commitRename}
                        onCancel={cancelRename}
                        className="min-w-[5rem] max-w-[14rem] h-[var(--ui-chip-height)] px-1.5 text-ui bg-bg border border-accent rounded-sm outline-none text-fg"
                      />
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
                    {renamingId !== t.id && <TerminalPrewarmIndicator terminal={t} />}
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
                  </span>
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
                        className="flex items-center justify-center w-5 ui-chip ui-chip-compact h-6 rounded hover:bg-bg-active"
                        onClick={e => {
                          e.stopPropagation()
                          if (shouldKeepShellAfterExit(t)) void useTerminalStore.getState().reopenTerminalShell(t.id)
                          else void restartTerminal(t.id)
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
                  {activityIndicator && (
                    <TerminalActivityDot terminalId={t.id} exited={t.status === 'exited'} />
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
                  ? translate('新建终端（默认配置）')
                  : translate('新建终端（无项目时将创建草稿项目）')
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
                if (creatingTerminal) return
                if (!shouldShowAppContextMenu(event)) return
                setProfileMenu({ x: event.clientX, y: event.clientY, trigger: event.currentTarget })
              }}
            >
              {creatingTerminal ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
            </button>
          </Tooltip>
          <Tooltip label={translate('选择终端配置')} side="top" wrapperClassName="inline-flex h-full shrink-0 items-center">
            <button
              type="button"
              aria-label={translate('选择终端配置')}
              aria-haspopup="menu"
              aria-expanded={profileMenu !== null}
              className="flex ui-chip h-6 w-4 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
              onClick={event => {
                if (profileMenu) {
                  setProfileMenu(null)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                setProfileMenu({ x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget })
              }}
            >
              <ChevronDown size={12} />
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
              <List size={16} />
              <span className="absolute bottom-0.5 right-0.5 min-w-[12px] h-[12px] rounded-sm bg-action px-0.5 text-center text-ui-2xs font-semibold leading-[12px] text-on-action">
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
                {collapseIcon}
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
                <X size={16} />
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
              <span className="ui-chip ui-chip-compact h-6 w-5 flex-shrink-0" />
              <span className="max-w-[12rem] truncate text-ui">{formatTerminalName(term.name)}</span>
              {hasPrewarmIndicator(term) && renamingId !== term.id && (
                <span data-terminal-prewarm="" className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              )}
              {term.status === 'reconnecting' && (
                <span className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              )}
              {term.status === 'exited' && <span className="ui-chip ui-chip-compact h-6 w-5 flex-shrink-0" />}
              {activityIndicator && <span className="h-3 w-3 flex-shrink-0" />}
            </div>
          ))}
        </div>
      </TerminalPaneHeader>
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
