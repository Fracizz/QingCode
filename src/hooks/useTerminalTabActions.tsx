import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  Plus,
  RotateCcw,
  X,
  Terminal as TerminalIcon,
  Pencil,
  XSquare,
  Files,
  ListTree,
  Settings2,
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
import { switchToTerminalProject } from './useTerminalProjectSelection'
import { exportTerminalDiagnostics } from '@/lib/terminal/terminalDiagnostics'
import { loadTerminalProfileSettings, getEffectiveDefaultProfileId } from '@/lib/terminal/terminalProfiles'
import {
  canCloseTerminalDirectly,
  listBusyTerminals,
  terminalCloseButtonAction,
} from '@/lib/terminal/terminalClose'
import { shouldKeepShellAfterExit } from '@/lib/terminal/terminalShellLifecycle'
import { formatTerminalName } from '../utils/terminalName'
import type { ContextMenuItem } from '../components/ContextMenu'
import type { TerminalTab } from '../types'
import { useI18n } from '../lib/i18n'

const CLOSE_ARM_MS = 4000

/** 拖拽落点在目标元素的前半还是后半；标签栏按横向判断，终端列表按纵向判断。 */
function dropPositionOf(
  event: ReactDragEvent<HTMLElement>,
  axis: 'horizontal' | 'vertical',
): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return axis === 'horizontal'
    ? event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    : event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * 终端标签栏与终端工作台列表共用的操作：切换、重命名、关闭（含二次确认）、
 * 新建与配置菜单、拖拽排序、右键菜单。视图只负责排版。
 */
export function useTerminalTabActions({
  pane,
  dropAxis = 'horizontal',
}: {
  /** When set, this view owns one dual-terminal pane. */
  pane?: TerminalFocusPane
  dropAxis?: 'horizontal' | 'vertical'
} = {}) {
  const { t: translate } = useI18n()
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
  const requestSettings = useUIStore(s => s.requestSettings)
  const [creatingTerminal, setCreatingTerminal] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    terminal: TerminalTab
  } | null>(null)
  const [profileMenu, setProfileMenu] = useState<{ x: number; y: number } | null>(null)
  const [closeArmId, setCloseArmId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [draggedTerminalId, setDraggedTerminalId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: 'before' | 'after'
  } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameCommittingRef = useRef(false)

  const allProjectTerminals = terminals.filter(t => t.projectId === currentProject?.id)
  // Dual/田: each pane strip only manages sessions it owns. Classic: show all.
  const projectTerminals = pane
    ? allProjectTerminals.filter(t => terminalPaneOf(t) === pane)
    : allProjectTerminals
  const atLimit = allProjectTerminals.length >= MAX_TERMINALS_PER_PROJECT

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

  /** activeTerminalId 只能指向当前项目；全项目列表里操作其他项目的行时不激活。 */
  const activateIfCurrentProject = (terminal: TerminalTab | undefined) => {
    if (terminal?.projectId === currentProject?.id && terminal) setActiveTerminal(terminal.id)
  }

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
    activateIfCurrentProject(terminal)
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
  const handleCloseAllInStrip = async (projectId: string | undefined = currentProject?.id) => {
    if (!projectId) return
    const targets = pane
      ? projectTerminals
      : terminals.filter(terminal => terminal.projectId === projectId)
    const running = await listBusyTerminals(targets)
    if (running.length > 0) {
      const confirmed = await confirmDialog({
        title: translate('关闭全部终端'),
        message: pane
          ? translate('将终止本窗格的 {count} 个运行中终端', { count: running.length })
          : projectId === currentProject?.id
            ? translate('将终止当前项目的 {count} 个运行中终端', { count: running.length })
            : translate('将终止该项目的 {count} 个运行中终端', { count: running.length }),
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
    await closeAllProjectTerminals(projectId)
  }

  /** 管理模式：关闭所选终端（可跨项目），运行中的合并成一次确认。 */
  const handleCloseSelected = async (ids: ReadonlyArray<string>) => {
    const wanted = new Set(ids)
    const targets = useTerminalStore.getState().terminals.filter(tab => wanted.has(tab.id))
    if (targets.length === 0) return
    const running = await listBusyTerminals(targets)
    if (running.length > 0) {
      const confirmed = await confirmDialog({
        title: translate('关闭所选终端'),
        message: translate('将终止 {count} 个运行中的终端', { count: running.length }),
        detail: translate('关闭后将终止对应 shell 进程，会话中的未保存输出会丢失。'),
        kind: 'warning',
        confirmLabel: translate('终止并关闭'),
        cancelLabel: translate('取消'),
      })
      if (!confirmed) return
    }
    setCloseArmId(null)
    for (const term of targets) await closeTerminal(term.id)
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
    activateIfCurrentProject(terminals.find(terminal => terminal.id === id))
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

  /** targetProjectId 指向其他项目时，先切过去再新建（同样经过信任与 SSH 检查）。 */
  const handleNewTerminal = (profileId?: string, targetProjectId?: string) => {
    if (creatingTerminal) return
    const crossProjectId =
      targetProjectId && targetProjectId !== currentProject?.id ? targetProjectId : null
    const limited = crossProjectId
      ? terminals.filter(terminal => terminal.projectId === crossProjectId).length >= MAX_TERMINALS_PER_PROJECT
      : Boolean(currentProject && atLimit)
    if (limited) {
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
        // 切换失败时信任弹窗或 SSH 流程已经给出提示，这里不重复。
        if (crossProjectId && !(await switchToTerminalProject(crossProjectId))) return
        const project = crossProjectId
          ? useProjectStore.getState().currentProject
          : currentProject ?? (await ensureProjectForTerminal())
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
    return [
      ...settings.profiles.map(profile => {
        const name = profile.id === 'default'
          ? translate('普通终端')
          : profile.name.trim() || translate('未命名配置')
        return {
          label: profile.id === effectiveDefaultId ? `${name}${translate('（默认）')}` : name,
          icon: <TerminalIcon size={14} />,
          disabled: atLimit || creatingTerminal,
          action: () => handleNewTerminal(profile.id),
        }
      }),
      {
        label: translate('管理终端配置'),
        icon: <Settings2 size={14} />,
        separatorBefore: true,
        action: () => requestSettings('终端配置'),
      },
      {
        label: translate('终端管理（全部项目与手机）'),
        icon: <ListTree size={14} />,
        action: () => useUIStore.getState().openTerminalManager(),
      },
    ]
  }

  const clearTerminalDrag = () => {
    setDraggedTerminalId(null)
    setDropTarget(null)
  }

  /** 终端的 cwd 和连接绑定项目，只允许在同一项目内排序。 */
  const sameProjectTerminals = (sourceId: string, targetId: string) => {
    const projectOf = (id: string) => terminals.find(terminal => terminal.id === id)?.projectId
    return projectOf(sourceId) === projectOf(targetId)
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
    if (!sourceId || sourceId === targetId || !sameProjectTerminals(sourceId, targetId)) {
      setDropTarget(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const position = dropPositionOf(event, dropAxis)
    setDropTarget(current =>
      current?.id === targetId && current.position === position
        ? current
        : { id: targetId, position },
    )
  }

  const handleTabDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    event.preventDefault()
    const sourceId = draggedTerminalId || event.dataTransfer.getData('text/plain')
    if (sourceId && sourceId !== targetId && sameProjectTerminals(sourceId, targetId)) {
      reorderTerminal(sourceId, targetId, dropPositionOf(event, dropAxis))
    }
    clearTerminalDrag()
  }

  /** 重启要用该项目的信任与 SSH 连接，其他项目的终端先切过去。 */
  const reloadTerminal = async (terminal: TerminalTab) => {
    if (terminal.projectId !== currentProject?.id && !(await switchToTerminalProject(terminal.projectId))) return
    await (terminal.status === 'exited' && shouldKeepShellAfterExit(terminal)
      ? useTerminalStore.getState().reopenTerminalShell(terminal.id)
      : restartTerminal(terminal.id))
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
      label: terminal.restoreUnavailable ? translate('重试接回') : translate('重新加载'),
      icon: <RotateCcw size={14} />,
      action: () => {
        void reloadTerminal(terminal)
      },
    },
    {
      label: translate('导出终端诊断'),
      action: async () => {
        const root = useProjectStore.getState().projects.find(project => project.id === terminal.projectId)?.path
        try { await exportTerminalDiagnostics(terminal, root) }
        catch (error) { useProjectStore.getState().pushToast('error', String(error)) }
      },
    },
    {
      label: translate('新建终端（默认配置）'),
      icon: <Plus size={14} />,
      disabled:
        terminals.filter(tab => tab.projectId === terminal.projectId).length >= MAX_TERMINALS_PER_PROJECT,
      action: () => handleNewTerminal(undefined, terminal.projectId),
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
      action: () => handleCloseAllInStrip(terminal.projectId),
    },
  ]

  return {
    translate,
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
    restartTerminal,
    reloadTerminal,
  }
}
