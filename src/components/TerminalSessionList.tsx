import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  Circle,
  LoaderCircle,
  Plus,
  RotateCcw,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import { useTerminalTabActions } from '../hooks/useTerminalTabActions'
import { useUIStore } from '../store/uiStore'
import { useTerminalStore, MAX_TERMINALS_PER_PROJECT } from '../store/terminalStore'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import {
  getTerminalActivityIndicator,
  subscribeTerminalActivityIndicator,
} from '@/lib/terminal/terminalActivitySettings'
import { shouldKeepShellAfterExit } from '@/lib/terminal/terminalShellLifecycle'
import { terminalSessionMeta, terminalTabTooltip } from '@/lib/terminal/terminalTabPresentation'
import { formatTerminalName } from '../utils/terminalName'
import ContextMenu from './ContextMenu'
import EmptyState from './EmptyState'
import TerminalActivityDot from './TerminalActivityDot'
import TerminalRenameInput from './TerminalRenameInput'
import Tooltip from './Tooltip'

const HEADER_BUTTON =
  'flex ui-chip h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40'
const ROW_BUTTON = 'flex ui-chip h-6 w-5 flex-shrink-0 items-center justify-center rounded'

/** 终端工作台左栏：当前项目的终端纵向列表，替代横向标签栏。 */
export default function TerminalSessionList() {
  const actions = useTerminalTabActions({ dropAxis: 'vertical' })
  const {
    translate,
    activateForPane,
    paneActiveId,
    currentProject,
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
  } = actions
  const openTerminalPanel = useUIStore(s => s.openTerminalPanel)
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)
  const activityIndicator = useSyncExternalStore(
    subscribeTerminalActivityIndicator,
    getTerminalActivityIndicator,
  )
  const newDisabled = Boolean(currentProject && atLimit) || creatingTerminal

  // 终端面板被收起时，选中列表项要把终端重新展开，否则点击没有可见效果。
  const selectTerminal = (id: string) => {
    activateForPane(id)
    openTerminalPanel()
    if (closeArmId && closeArmId !== id) setCloseArmId(null)
  }

  const restartExited = (id: string, keepShell: boolean) => {
    if (keepShell) void useTerminalStore.getState().reopenTerminalShell(id)
    else void restartTerminal(id)
  }

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return
    const count = projectTerminals.length
    if (count === 0) return
    const current = projectTerminals.findIndex(term => term.id === paneActiveId)
    let nextIndex: number
    if (event.key === 'ArrowDown') nextIndex = (current + 1) % count
    else if (event.key === 'ArrowUp') nextIndex = (current - 1 + count) % count
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = count - 1
    else return
    event.preventDefault()
    const next = projectTerminals[nextIndex]
    if (!next) return
    selectTerminal(next.id)
    event.currentTarget
      .querySelector<HTMLElement>(`[data-terminal-session-row="${next.id}"]`)
      ?.focus()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-sidebar" data-terminal-session-list>
      <div className="flex h-9 flex-shrink-0 items-center gap-0.5 pl-3 pr-1.5 text-ui-xs font-semibold tracking-wide text-fg-muted">
        <span className="min-w-0 flex-1 truncate">
          {translate('终端')}
          {projectTerminals.length > 0 && (
            <span className="ml-1.5 font-normal text-fg-dim">{projectTerminals.length}</span>
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
            onClick={() => handleNewTerminal()}
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
            aria-expanded={profileMenu !== null}
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
        <Tooltip label={translate('关闭全部终端')} side="bottom">
          <button
            type="button"
            aria-label={translate('关闭全部终端')}
            className={HEADER_BUTTON}
            disabled={projectTerminals.length === 0}
            onClick={() => void handleCloseAllProject()}
          >
            <X size={15} />
          </button>
        </Tooltip>
      </div>

      {projectTerminals.length === 0 ? (
        <EmptyState
          className="min-h-0 flex-1"
          icon={<TerminalIcon size={28} strokeWidth={1.2} />}
          title={
            currentProject
              ? translate('当前项目「{name}」暂无终端，点击上方 + 新建', { name: currentProject.name })
              : translate('请先选择或添加项目，终端将默认基于当前项目创建')
          }
        />
      ) : (
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label={translate('终端')}
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5"
          onKeyDown={onListKeyDown}
        >
          {projectTerminals.map(term => {
            const isActive = term.id === paneActiveId
            const isCloseArmed = closeArmId === term.id
            const isRenaming = renamingId === term.id
            const exited = term.status === 'exited'
            const keepShell = shouldKeepShellAfterExit(term)
            const exitCodeSuffix =
              term.exitCode === null ? '' : translate('（退出码 {code}）', { code: term.exitCode })
            const restartLabel = keepShell ? '重启终端{exitCode}' : '按原运行配置重启{exitCode}'
            const meta = terminalSessionMeta(term, translate)
            return (
              <div
                key={term.id}
                role="tab"
                data-terminal-session-row={term.id}
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                draggable={!isRenaming}
                className={`group relative flex min-h-9 flex-shrink-0 cursor-pointer select-none items-center gap-1.5 rounded py-1 pl-2.5 pr-1 transition-colors ${
                  isActive ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                } ${draggedTerminalId === term.id ? 'opacity-45' : ''}`}
                onDragStart={event => handleTabDragStart(event, term.id)}
                onDragOver={event => handleTabDragOver(event, term.id)}
                onDrop={event => handleTabDrop(event, term.id)}
                onDragEnd={clearTerminalDrag}
                onClick={() => selectTerminal(term.id)}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    selectTerminal(term.id)
                  }
                }}
                onDoubleClick={event => {
                  // 行内按钮的双击不能进入重命名（连点关闭时很常见）。
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
                {isActive && (
                  <span
                    className="pointer-events-none absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded bg-brand"
                    aria-hidden="true"
                  />
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
                      label={terminalTabTooltip(term, translate)}
                      side="right"
                      wrapperClassName="flex min-w-0 flex-col"
                    >
                      <span className={`truncate text-ui ${exited ? 'opacity-60' : ''}`}>
                        {formatTerminalName(term.name)}
                      </span>
                      {meta && <span className="truncate text-ui-xs text-fg-dim">{meta}</span>}
                    </Tooltip>
                  )}
                </div>
                {term.status === 'reconnecting' && !isRenaming && (
                  <LoaderCircle
                    size={12}
                    aria-label={translate('正在重新连接…')}
                    className="flex-shrink-0 animate-spin text-warn"
                  />
                )}
                {exited && !isRenaming && (
                  <Tooltip label={translate(restartLabel, { exitCode: exitCodeSuffix })} side="top">
                    <button
                      type="button"
                      aria-label={translate(restartLabel, { exitCode: '' })}
                      className={`${ROW_BUTTON} hover:bg-bg-active`}
                      onClick={event => {
                        event.stopPropagation()
                        restartExited(term.id, keepShell)
                      }}
                    >
                      <RotateCcw size={12} />
                    </button>
                  </Tooltip>
                )}
                {activityIndicator && <TerminalActivityDot terminalId={term.id} exited={exited} />}
                <Tooltip
                  label={isCloseArmed ? translate('再次点击关闭终端') : translate('关闭终端')}
                  side="top"
                  forceOpen={isCloseArmed}
                >
                  <button
                    type="button"
                    aria-label={isCloseArmed ? translate('确认关闭终端') : translate('关闭终端')}
                    data-terminal-close={term.id}
                    className={`${ROW_BUTTON} ${
                      isCloseArmed
                        ? 'bg-danger/15 text-danger'
                        : `hover:bg-bg-active ${
                            isActive ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                          }`
                    }`}
                    onClick={event => handleCloseClick(event, term.id)}
                  >
                    {isCloseArmed ? <Circle size={9} fill="currentColor" /> : <X size={13} />}
                  </button>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}

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
    </div>
  )
}
