import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Circle, Plus, RotateCcw, X, Terminal as TerminalIcon, Pencil, XSquare, Files } from 'lucide-react'
import { MAX_TERMINALS_PER_PROJECT, useTerminalStore } from '../store/terminalStore'
import { useProjectStore } from '../store/projectStore'
import { confirmDialog } from '../store/confirmStore'
import { promptDialog } from '../store/promptStore'
import { formatTerminalName } from '../utils/terminalName'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import type { TerminalTab } from '../types'

const CLOSE_ARM_MS = 4000

export default function TerminalTabs() {
  const terminals = useTerminalStore(s => s.terminals)
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId)
  const setActiveTerminal = useTerminalStore(s => s.setActiveTerminal)
  const closeTerminal = useTerminalStore(s => s.closeTerminal)
  const closeOtherTerminals = useTerminalStore(s => s.closeOtherTerminals)
  const closeAllProjectTerminals = useTerminalStore(s => s.closeAllProjectTerminals)
  const restartTerminal = useTerminalStore(s => s.restartTerminal)
  const renameTerminal = useTerminalStore(s => s.renameTerminal)
  const addTerminal = useTerminalStore(s => s.addTerminal)
  const currentProject = useProjectStore(s => s.currentProject)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    terminal: TerminalTab
  } | null>(null)
  const [closeArmId, setCloseArmId] = useState<string | null>(null)

  const projectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  const atLimit = projectTerminals.length >= MAX_TERMINALS_PER_PROJECT

  useEffect(() => {
    if (!closeArmId) return
    if (!terminals.some(t => t.id === closeArmId)) setCloseArmId(null)
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
    if (closeArmId === id) {
      void handleCloseTab(id)
      return
    }
    setActiveTerminal(id)
    setCloseArmId(id)
  }

  const handleClose = async (id: string) => {
    const terminal = terminals.find(tab => tab.id === id)
    if (!terminal) return
    if (terminal.status !== 'exited') {
      const confirmed = await confirmDialog({
        title: '关闭终端',
        message: `「${formatTerminalName(terminal.name)}」仍在运行`,
        detail: '关闭后将终止当前 shell 进程，会话中的未保存输出会丢失。',
        kind: 'warning',
        confirmLabel: '终止并关闭',
        cancelLabel: '取消',
      })
      if (!confirmed) return
    }
    await closeTerminal(id)
  }

  const handleCloseOthers = async (id: string) => {
    const terminal = terminals.find(tab => tab.id === id)
    if (!terminal) return
    const runningOthers = terminals.filter(
      t => t.projectId === terminal.projectId && t.id !== id && t.status !== 'exited'
    )
    if (runningOthers.length > 0) {
      const confirmed = await confirmDialog({
        title: '关闭其它终端',
        message: `将终止 ${runningOthers.length} 个运行中的终端`,
        detail: '关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。',
        kind: 'warning',
        confirmLabel: '终止并关闭',
        cancelLabel: '取消',
      })
      if (!confirmed) return
    }
    await closeOtherTerminals(id)
  }

  const handleCloseAll = async () => {
    if (!currentProject) return
    const running = projectTerminals.filter(t => t.status !== 'exited')
    if (running.length > 0) {
      const confirmed = await confirmDialog({
        title: '关闭全部终端',
        message: `将终止当前项目的 ${running.length} 个运行中终端`,
        detail: '关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。',
        kind: 'warning',
        confirmLabel: '终止并关闭',
        cancelLabel: '取消',
      })
      if (!confirmed) return
    }
    await closeAllProjectTerminals(currentProject.id)
  }

  const handleRename = async (id: string, currentName: string) => {
    const name = await promptDialog({
      title: '重命名终端',
      message: '为当前项目的终端设置显示名称',
      defaultValue: currentName,
      placeholder: '例如 dev-server',
      confirmLabel: '保存',
    })
    if (name) renameTerminal(id, name)
  }

  const handleNewTerminal = () => {
    if (!currentProject) {
      useProjectStore.getState().pushToast('info', '请先选择或添加项目，再创建终端')
      return
    }
    if (atLimit) {
      useProjectStore.getState().pushToast(
        'info',
        `已达到每个项目 ${MAX_TERMINALS_PER_PROJECT} 个终端的上限`
      )
      return
    }
    addTerminal(currentProject.path, currentProject.id)
  }

  const menuItems = (terminal: TerminalTab): ContextMenuItem[] => [
    {
      label: '重命名',
      icon: <Pencil size={14} />,
      action: () => handleRename(terminal.id, terminal.name),
    },
    {
      label: '新建终端（同项目）',
      icon: <Plus size={14} />,
      disabled: atLimit,
      action: handleNewTerminal,
    },
    {
      label: '关闭',
      icon: <X size={14} />,
      separatorBefore: true,
      action: () => handleClose(terminal.id),
    },
    {
      label: '关闭其它',
      icon: <XSquare size={14} />,
      action: () => handleCloseOthers(terminal.id),
    },
    {
      label: '关闭全部',
      icon: <Files size={14} />,
      action: handleCloseAll,
    },
  ]

  return (
    <>
    <div className="ui-font-scaled h-9 flex bg-bg-deep border-t border-border items-center flex-shrink-0">
        <div className="flex items-center gap-1.5 px-3 text-[11px] font-semibold tracking-widest uppercase text-fg-muted">
          <TerminalIcon size={13} /> Terminal
        </div>
        <div className="flex flex-1 min-w-0 overflow-x-auto items-center">
          {projectTerminals.map(t => (
            <Tooltip key={t.id} label="双击重命名终端" side="bottom" wrapperClassName="flex h-full flex-shrink-0">
              <div
                className={`group flex items-center gap-1.5 pl-3 pr-2 h-9 cursor-pointer border-r border-border whitespace-nowrap transition-colors
                  ${t.id === activeTerminalId ? 'bg-bg text-fg' : 'bg-bg-deep text-fg-muted hover:bg-bg-elevated hover:text-fg'}`}
                onClick={() => {
                  setActiveTerminal(t.id)
                  if (closeArmId && closeArmId !== t.id) setCloseArmId(null)
                }}
                onDoubleClick={() => handleRename(t.id, t.name)}
                onContextMenu={(event: ReactMouseEvent) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
                  setContextMenu({ x: event.clientX, y: event.clientY, terminal: t })
                }}
              >
                <Circle
                  size={7}
                  fill="currentColor"
                  className={
                    t.status === 'running'
                      ? 'text-ok'
                      : t.status === 'starting'
                        ? 'text-warn'
                        : 'text-fg-dim'
                  }
                />
                <span className="text-[13px]">{formatTerminalName(t.name)}</span>
                {t.status === 'exited' && (
                  <Tooltip
                    label={`重启终端${t.exitCode === null ? '' : `（退出码 ${t.exitCode}）`}`}
                    side="bottom"
                  >
                    <button
                      className="ml-1 flex items-center justify-center w-4 h-4 rounded hover:bg-bg-active"
                      onClick={e => {
                        e.stopPropagation()
                        restartTerminal(t.id)
                      }}
                    >
                      <RotateCcw size={12} />
                    </button>
                  </Tooltip>
                )}
                <Tooltip
                  label={closeArmId === t.id ? '再次点击关闭终端' : '关闭终端'}
                  side="bottom"
                >
                  <button
                    type="button"
                    aria-label={closeArmId === t.id ? '确认关闭终端' : '关闭终端'}
                    data-terminal-close={t.id}
                    className={`ml-1 flex items-center justify-center w-4 h-4 rounded transition-colors ${
                      closeArmId === t.id
                        ? 'bg-danger/15 text-danger'
                        : 'hover:bg-bg-active'
                    }`}
                    onClick={e => handleCloseClick(e, t.id)}
                  >
                    {closeArmId === t.id ? (
                      <Circle size={9} fill="currentColor" />
                    ) : (
                      <X size={13} className="opacity-60 group-hover:opacity-100" />
                    )}
                  </button>
                </Tooltip>
              </div>
            </Tooltip>
          ))}
          <Tooltip
            label={
              atLimit
                ? `已达到每个项目 ${MAX_TERMINALS_PER_PROJECT} 个终端的上限`
                : currentProject
                  ? `在当前项目内新建终端（${currentProject.path}）`
                  : '请先选择项目'
            }
            side="bottom"
            wrapperClassName="flex-shrink-0"
          >
            <button
              type="button"
              aria-label="新建终端"
              className={`ml-1 mr-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors ${
                currentProject && !atLimit
                  ? 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  : 'text-fg-dim cursor-not-allowed'
              }`}
              disabled={!currentProject || atLimit}
              onClick={handleNewTerminal}
            >
              <Plus size={15} />
            </button>
          </Tooltip>
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
    </>
  )
}
