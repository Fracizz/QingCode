import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  Folder,
  AlertTriangle,
  Plus,
  X,
  ExternalLink,
  LocateFixed,
  Check,
  Pencil,
  ListChecks,
  Layers,
  Search,
  RefreshCw,
  Copy,
  CopyX,
  XSquare,
  ArrowLeftToLine,
  EyeOff,
} from 'lucide-react'
import { openPath } from '@tauri-apps/plugin-opener'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  relocateProjectWithDialog,
  removeProjectWithConfirm,
  renameProjectWithPrompt,
} from '../utils/projectActions'
import { copyPathAction } from '../lib/copyFileActions'
import { shouldShowAppContextMenu, deferToNativeContextMenuInDev } from '../lib/devBuild'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import WorkspaceMenu from './WorkspaceMenu'
import ProjectAddDialog from './ProjectAddDialog'
import type { Project } from '../types'
import { useI18n } from '../lib/i18n'
import { insertLineXForDraggedChip, previewReorderIds, sameIdOrder, sortVisibleProjects } from '../lib/projectChipOrder'
import { EMPTY_PROJECT_INDICATORS, useProjectIndicators, type ProjectIndicators } from '../hooks/useProjectIndicators'
import { ProjectIndicatorMarks, useProjectIndicatorsVisible } from './ProjectIndicatorMarks'

const CHIP_GAP = 4
const ADD_BTN_W = 28
const OVERFLOW_BTN_W = 28
/** Pointer DnD threshold — HTML5 DnD is flaky in WebView2 title bar (see Sidebar). */
const DRAG_THRESHOLD_PX = 5

export default function ProjectPicker() {
  const { t } = useI18n()
  const allProjects = useProjectStore(s => s.projects)
  const projects = useMemo(() => sortVisibleProjects(allProjects), [allProjects])
  const currentProject = useProjectStore(s => s.currentProject)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const switchProject = useProjectStore(s => s.switchProject)
  const hideProject = useProjectStore(s => s.hideProject)
  const hideProjectsByIds = useProjectStore(s => s.hideProjectsByIds)
  const refreshProjectTree = useProjectStore(s => s.refreshProjectTree)
  const reorderVisibleProjects = useProjectStore(s => s.reorderVisibleProjects)
  const setView = useUIStore(s => s.setView)
  const requestSearch = useUIStore(s => s.requestSearch)
  const openProjectManager = useUIStore(s => s.openProjectManager)
  const openWorkspaceManager = useUIStore(s => s.openWorkspaceManager)
  const projectIndicators = useProjectIndicators(projects, unavailableProjectIds)

  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const chipDragRef = useRef<{
    dragId: string
    originIds: string[]
    previewIds: string[]
    widthsById: Map<string, number>
    pointerId: number
    startX: number
    startY: number
    active: boolean
    raf: number | null
    pendingClientX: number | null
  } | null>(null)
  const suppressChipClickRef = useRef(false)

  const [visibleCount, setVisibleCount] = useState(projects.length)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [previewIds, setPreviewIds] = useState<string[] | null>(null)
  const [insertLineX, setInsertLineX] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    project: Project
  } | null>(null)

  // Recompute how many chips fit whenever projects or container width change.
  useLayoutEffect(() => {
    const measure = measureRef.current
    const container = containerRef.current
    if (!measure || !container) return

    const compute = () => {
      const widths = new Map<string, number>()
      measure
        .querySelectorAll<HTMLDivElement>('[data-chip-id]')
        .forEach(el => widths.set(el.dataset.chipId ?? '', el.offsetWidth))
      const available = container.clientWidth
      let total = ADD_BTN_W
      let count = 0
      for (let i = 0; i < projects.length; i++) {
        const w = (widths.get(projects[i].id) ?? 0) + CHIP_GAP
        const allShown = count + 1 === projects.length
        const reserveOverflow = allShown ? 0 : OVERFLOW_BTN_W + CHIP_GAP
        if (total + w + reserveOverflow > available) break
        total += w
        count++
      }
      setVisibleCount(count)
    }

    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(container)
    return () => ro.disconnect()
  }, [projects])

  const closeDropdown = () => setOverflowOpen(false)

  useEffect(() => {
    if (!overflowOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (dropdownRef.current?.contains(target)) return
      if (overflowBtnRef.current?.contains(target)) return
      closeDropdown()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDropdown()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', closeDropdown)
    window.addEventListener('blur', closeDropdown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', closeDropdown)
      window.removeEventListener('blur', closeDropdown)
    }
  }, [overflowOpen])

  const positionDropdown = () => {
    const rect = overflowBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 240
    setDropdownStyle({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 4,
      width,
    })
  }

  const handleSwitch = async (project: Project) => {
    if (suppressChipClickRef.current) return
    closeDropdown()
    setView('explorer')
    await switchProject(project)
  }

  const handleChipPointerDown = (event: ReactPointerEvent, projectId: string) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    event.stopPropagation()

    const visibleIds = projects.slice(0, visibleCount).map(p => p.id)
    if (!visibleIds.includes(projectId)) return

    const widthsById = new Map<string, number>()
    measureRef.current
      ?.querySelectorAll<HTMLDivElement>('[data-chip-id]')
      .forEach(el => {
        const id = el.dataset.chipId
        if (id) widthsById.set(id, el.offsetWidth)
      })

    chipDragRef.current = {
      dragId: projectId,
      originIds: visibleIds,
      previewIds: visibleIds,
      widthsById,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      raf: null,
      pendingClientX: null,
    }

    const endDragSession = () => {
      const session = chipDragRef.current
      if (session?.raf != null) cancelAnimationFrame(session.raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKeyDown)
      document.body.classList.remove('select-none')
      chipDragRef.current = null
    }

    const applyPreviewAt = (clientX: number) => {
      const session = chipDragRef.current
      const container = containerRef.current
      if (!session?.active || !container) return
      const x = clientX - container.getBoundingClientRect().left
      const next = previewReorderIds(
        session.previewIds,
        session.dragId,
        session.widthsById,
        CHIP_GAP,
        x,
      )
      if (!sameIdOrder(next, session.previewIds)) {
        session.previewIds = next
        setPreviewIds(next)
      }
      if (sameIdOrder(next, session.originIds)) {
        setInsertLineX(null)
        return
      }
      setInsertLineX(
        insertLineXForDraggedChip(next, session.dragId, session.widthsById, CHIP_GAP),
      )
    }

    const onMove = (moveEvent: PointerEvent) => {
      const session = chipDragRef.current
      if (!session || moveEvent.pointerId !== session.pointerId) return
      const dx = moveEvent.clientX - session.startX
      const dy = moveEvent.clientY - session.startY
      if (!session.active) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return
        session.active = true
        suppressChipClickRef.current = true
        document.body.classList.add('select-none')
        setDragId(session.dragId)
        setPreviewIds(session.originIds)
      }
      session.pendingClientX = moveEvent.clientX
      if (session.raf != null) return
      session.raf = requestAnimationFrame(() => {
        const current = chipDragRef.current
        if (!current) return
        current.raf = null
        const x = current.pendingClientX
        current.pendingClientX = null
        if (x != null) applyPreviewAt(x)
      })
    }

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      endDragSession()
      setDragId(null)
      setPreviewIds(null)
      setInsertLineX(null)
      window.setTimeout(() => {
        suppressChipClickRef.current = false
      }, 0)
    }

    const onUp = (upEvent: PointerEvent) => {
      const session = chipDragRef.current
      if (!session || upEvent.pointerId !== session.pointerId) {
        endDragSession()
        return
      }
      if (!session.active) {
        endDragSession()
        window.setTimeout(() => {
          suppressChipClickRef.current = false
        }, 0)
        return
      }

      if (session.pendingClientX != null) applyPreviewAt(session.pendingClientX)
      const finalIds = session.previewIds
      const fromIndex = session.originIds.indexOf(session.dragId)
      const toIndex = finalIds.indexOf(session.dragId)
      endDragSession()
      setDragId(null)
      setPreviewIds(null)
      setInsertLineX(null)
      if (fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) {
        void reorderVisibleProjects(fromIndex, toIndex)
      }
      window.setTimeout(() => {
        suppressChipClickRef.current = false
      }, 0)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKeyDown)
  }

  const handleRename = (project: Project) => {
    closeDropdown()
    void renameProjectWithPrompt(project.id, project.name)
  }

  const handleOpenInExplorer = async (path: string) => {
    closeDropdown()
    try {
      await openPath(path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', `打开项目目录失败: ${String(e)}`)
    }
  }

  const handleRemove = (project: Project) => {
    closeDropdown()
    if (unavailableProjectIds.includes(project.id)) {
      void removeProjectWithConfirm(project.id, project.name, project.path)
      return
    }
    void hideProject(project.id)
  }

  const handleManageProjects = () => {
    closeDropdown()
    openProjectManager()
  }

  const handleManageWorkspaces = () => {
    closeDropdown()
    openWorkspaceManager()
  }

  const handleRelocate = (id: string) => {
    closeDropdown()
    void relocateProjectWithDialog(id)
  }

  const projectMenuItems = (project: Project): ContextMenuItem[] => {
    const unavailable = unavailableProjectIds.includes(project.id)
    const index = projects.findIndex(p => p.id === project.id)
    const leftIds = index > 0 ? projects.slice(0, index).map(p => p.id) : []
    const rightIds = index >= 0 ? projects.slice(index + 1).map(p => p.id) : []
    const otherIds = projects.filter(p => p.id !== project.id).map(p => p.id)
    const closeByIds = (ids: string[]) => {
      closeDropdown()
      void hideProjectsByIds(ids, project.id)
    }
    const activateThen = async (action: () => Promise<void>) => {
      if (currentProject?.id !== project.id) await switchProject(project)
      await action()
    }
    return [
      {
        label: t('在此项目内搜索'),
        icon: <Search size={14} />,
        disabled: unavailable,
        action: () => void activateThen(async () => {
          requestSearch(project.path)
        }),
      },
      {
        label: t('刷新项目'),
        icon: <RefreshCw size={14} />,
        separatorBefore: true,
        disabled: unavailable,
        action: () => void activateThen(() => refreshProjectTree(project)),
      },
      {
        label: t('在文件管理器中打开'),
        icon: <ExternalLink size={14} />,
        disabled: unavailable,
        action: () => void handleOpenInExplorer(project.path),
      },
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        action: () => void copyPathAction(project.path),
      },
      {
        label: t('重命名项目'),
        icon: <Pencil size={14} />,
        separatorBefore: true,
        action: () => handleRename(project),
      },
      {
        label: t('重新定位项目'),
        icon: <LocateFixed size={14} />,
        action: () => handleRelocate(project.id),
      },
      {
        label: unavailable ? t('移除项目') : t('从顶栏隐藏'),
        icon: unavailable ? <X size={14} /> : <EyeOff size={14} />,
        separatorBefore: true,
        action: () => handleRemove(project),
      },
      {
        label: t('关闭其它'),
        icon: <XSquare size={14} />,
        disabled: otherIds.length === 0,
        action: () => closeByIds(otherIds),
      },
      {
        label: t('关闭左侧'),
        icon: <ArrowLeftToLine size={14} />,
        disabled: leftIds.length === 0,
        action: () => closeByIds(leftIds),
      },
      {
        label: t('关闭右侧'),
        icon: <CopyX size={14} />,
        disabled: rightIds.length === 0,
        action: () => closeByIds(rightIds),
      },
    ]
  }

  const openProjectContextMenu = (event: ReactMouseEvent, project: Project) => {
    if (!shouldShowAppContextMenu(event)) return
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
    closeDropdown()
    setContextMenu({ x: event.clientX, y: event.clientY, project })
  }

  const openOverflow = (event: ReactMouseEvent) => {
    event.stopPropagation()
    positionDropdown()
    setOverflowOpen(v => !v)
  }

  const openAddDialog = (event: ReactMouseEvent) => {
    event.stopPropagation()
    closeDropdown()
    setAddDialogOpen(true)
  }

  const displayVisibleProjects = useMemo(() => {
    if (!previewIds) return projects.slice(0, visibleCount)
    const byId = new Map(projects.map(p => [p.id, p]))
    return previewIds
      .map(id => byId.get(id))
      .filter((project): project is Project => project != null)
  }, [projects, previewIds, visibleCount])
  const overflowProjects = projects.slice(visibleCount)
  const hasOverflow = overflowProjects.length > 0

  return (
    <div className="relative overflow-hidden flex-1 flex items-center h-full min-w-0 gap-1">
      {/* Keep workspace control next to the file menu — not pushed to the far right. */}
      <WorkspaceMenu />

      {/* Keep the dynamic chip strip in the client area. Marking this whole
          container as app-region: drag makes WebView2 subtract every interactive
          chip/button from the native region. The inert filler owns dragging. */}
      <div
        ref={containerRef}
        className="relative flex-1 flex items-center h-full min-w-0 gap-1 overflow-hidden"
      >
        {insertLineX !== null && dragId !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0.5 bottom-0.5 w-0.5 rounded-full bg-accent z-10"
            style={{ left: insertLineX }}
          />
        )}
        {displayVisibleProjects.map((project, index) => {
          const unavailable = unavailableProjectIds.includes(project.id)
          return (
          <Chip
            key={project.id}
            chipIndex={index}
            project={project}
            indicators={projectIndicators[project.id] ?? EMPTY_PROJECT_INDICATORS}
            isCurrent={currentProject?.id === project.id}
            unavailable={unavailable}
            dragging={dragId === project.id}
            onSwitch={() => void handleSwitch(project)}
            onRemove={() => handleRemove(project)}
            onRelocate={() => handleRelocate(project.id)}
            onOpenInExplorer={() => void handleOpenInExplorer(project.path)}
            onContextMenu={event => openProjectContextMenu(event, project)}
            onPointerDown={
              unavailable ? undefined : event => handleChipPointerDown(event, project.id)
            }
          />
          )
        })}

        {hasOverflow && (
          <Tooltip label={t('更多项目')} side="bottom" wrapperClassName="flex-shrink-0">
            <button
              ref={overflowBtnRef}
              type="button"
              aria-label={t('更多项目')}
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              onClick={openOverflow}
              onDoubleClick={event => event.stopPropagation()}
              className={`flex items-center justify-center h-6 w-7 rounded text-[13px] flex-shrink-0 transition-colors
                ${overflowOpen ? 'bg-bg-active text-fg' : 'text-fg-muted hover:text-fg hover:bg-bg-hover'}`}
            >
              <ChevronDown
                size={14}
                className={`transition-transform ${overflowOpen ? 'rotate-180' : ''}`}
              />
            </button>
          </Tooltip>
        )}

        <Tooltip label={t('添加项目')} side="bottom" wrapperClassName="flex-shrink-0">
          <button
            type="button"
            aria-label={t('添加项目')}
            aria-haspopup="dialog"
            onClick={openAddDialog}
            onDoubleClick={event => event.stopPropagation()}
            className="flex items-center justify-center h-6 w-7 rounded text-[13px] flex-shrink-0 transition-colors text-fg-muted hover:text-fg hover:bg-bg-hover"
          >
            <Plus size={14} />
          </button>
        </Tooltip>

        {projects.length === 0 && (
          <button
            type="button"
            aria-label={t('添加项目')}
            aria-haspopup="dialog"
            onClick={openAddDialog}
            onDoubleClick={event => event.stopPropagation()}
            className="flex items-center h-6 px-2 rounded text-[13px] transition-colors text-fg-muted hover:text-fg hover:bg-bg-hover"
          >
            {t('添加项目')}
          </button>
        )}

        {/* Absorbs leftover width after chips. Keeping the native drag region on
            this inert leaf avoids hit-testing the dynamic chip subtree.
            `-ml-1` cancels the container gap so overflow measurement is unaffected. */}
        <div
          className="flex-1 self-stretch min-w-0 -ml-1"
          data-tauri-drag-region
        />
      </div>

      {/* Hidden measuring layer: renders every chip at natural width so we can compute overflow. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="absolute pointer-events-none invisible flex items-center h-full gap-1 left-0 top-0"
      >
        {projects.map(project => (
          <Chip
            key={project.id}
            project={project}
            indicators={projectIndicators[project.id] ?? EMPTY_PROJECT_INDICATORS}
            isCurrent={currentProject?.id === project.id}
            unavailable={unavailableProjectIds.includes(project.id)}
            measure
            onSwitch={() => {}}
            onRemove={() => {}}
            onRelocate={() => {}}
            onOpenInExplorer={() => {}}
            onContextMenu={() => {}}
          />
        ))}
      </div>

      {overflowOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            className="ui-font-scaled fixed z-[100] rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45 max-h-[70vh] flex flex-col"
            style={dropdownStyle}
            onPointerDown={event => event.stopPropagation()}
            onContextMenu={event => {
              if (!deferToNativeContextMenuInDev()) event.preventDefault()
            }}
          >
            <div className="px-3 py-1 text-[11px] font-semibold tracking-wide text-fg-muted">
              {t('更多项目')}
            </div>
            <div className="flex-1 overflow-auto">
              {overflowProjects.map(project => {
                const unavailable = unavailableProjectIds.includes(project.id)
                const isCurrent = currentProject?.id === project.id
                return (
                  <div
                    key={project.id}
                    role="menuitem"
                    tabIndex={unavailable ? -1 : 0}
                    onClick={() => !unavailable && handleSwitch(project)}
                    onContextMenu={event => openProjectContextMenu(event, project)}
                    className={`group flex items-center gap-2 border-l-2 px-3 py-1.5 text-[13px] outline-none
                      ${
                        isCurrent
                          ? 'border-brand bg-bg-active text-fg'
                          : unavailable
                          ? 'border-transparent text-fg-dim'
                          : 'cursor-pointer border-transparent text-fg hover:bg-bg-hover focus:bg-bg-active'
                      }`}
                  >
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      {unavailable ? (
                        <AlertTriangle size={14} className="text-warn" />
                      ) : isCurrent ? (
                        <Check size={13} className="text-brand" />
                      ) : (
                        <Folder size={14} className="text-accent" />
                      )}
                    </span>
                    <Tooltip
                      label={project.path}
                      side="right"
                      wrapperClassName="truncate min-w-0 flex-1"
                    >
                      <span className="truncate">{project.name}</span>
                    </Tooltip>
                    <ProjectIndicatorMarks
                      project={project}
                      indicators={projectIndicators[project.id] ?? EMPTY_PROJECT_INDICATORS}
                      isCurrent={isCurrent}
                    />
                    <Tooltip label={t('重命名项目')} side="right" wrapperClassName="flex-shrink-0">
                      <button
                        type="button"
                        aria-label={t('重命名项目')}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-fg-dim hover:text-fg"
                        onClick={event => {
                          event.stopPropagation()
                          handleRename(project)
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    </Tooltip>
                    {unavailable ? (
                      <Tooltip label={t('重新定位项目')} side="right" wrapperClassName="flex-shrink-0">
                        <button
                          type="button"
                          aria-label={t('重新定位项目')}
                          className="text-warn hover:text-fg"
                          onClick={event => {
                            event.stopPropagation()
                            handleRelocate(project.id)
                          }}
                        >
                          <LocateFixed size={13} />
                        </button>
                      </Tooltip>
                    ) : (
                      <Tooltip
                        label={t('在文件管理器中打开')}
                        side="right"
                        wrapperClassName="flex-shrink-0"
                      >
                        <button
                          type="button"
                          aria-label={t('在文件管理器中打开')}
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-fg-dim hover:text-fg"
                          onClick={event => {
                            event.stopPropagation()
                            void handleOpenInExplorer(project.path)
                          }}
                        >
                          <ExternalLink size={13} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip
                      label={unavailable ? t('移除项目') : t('从顶栏隐藏')}
                      side="right"
                      wrapperClassName="flex-shrink-0"
                    >
                      <button
                        type="button"
                        aria-label={unavailable ? t('移除项目') : t('从顶栏隐藏')}
                        className={`${
                          unavailable
                            ? 'text-fg-dim hover:text-danger'
                            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-fg-dim hover:text-danger'
                        }`}
                        onClick={event => {
                          event.stopPropagation()
                          handleRemove(project)
                        }}
                      >
                        <X size={13} />
                      </button>
                    </Tooltip>
                  </div>
                )
              })}
            </div>
            <div className="border-t border-border-strong mt-1 pt-1">
              <button
                type="button"
                role="menuitem"
                onClick={handleManageProjects}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-fg hover:bg-bg-active focus:bg-bg-active outline-none"
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
                  <ListChecks size={14} />
                </span>
                {t('项目管理')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleManageWorkspaces}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-fg hover:bg-bg-active focus:bg-bg-active outline-none"
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-fg-muted">
                  <Layers size={14} />
                </span>
                {t('多项目工作区')}
              </button>
            </div>
          </div>,
          document.body,
        )}

      <ProjectAddDialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={projectMenuItems(contextMenu.project)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function Chip({
  project,
  indicators,
  chipIndex,
  isCurrent,
  unavailable,
  measure = false,
  dragging = false,
  onSwitch,
  onRemove,
  onRelocate,
  onOpenInExplorer,
  onContextMenu,
  onPointerDown,
}: {
  project: Project
  indicators: ProjectIndicators
  chipIndex?: number
  isCurrent: boolean
  unavailable: boolean
  measure?: boolean
  dragging?: boolean
  onSwitch: () => void
  onRemove: () => void
  onRelocate: () => void
  onOpenInExplorer: () => void
  onContextMenu: (event: ReactMouseEvent) => void
  onPointerDown?: (event: ReactPointerEvent) => void
}) {
  const { t } = useI18n()
  const showIndicators = useProjectIndicatorsVisible()
  const statusLabel = [
    project.name,
    showIndicators && indicators.running > 0
      ? t('运行中的终端 {count}', { count: indicators.running })
      : '',
    showIndicators && indicators.dirtyEditors > 0
      ? t('未保存文件 {count}', { count: indicators.dirtyEditors })
      : '',
    showIndicators && indicators.gitChanges > 0
      ? t('Git 更改 {count}', { count: indicators.gitChanges })
      : '',
  ].filter(Boolean).join(' · ')
  const activate = () => {
    if (!unavailable) onSwitch()
  }
  return (
    <div
      data-chip-id={measure ? project.id : undefined}
      data-chip-index={measure ? undefined : chipIndex}
      role={measure ? undefined : 'button'}
      tabIndex={measure || unavailable ? -1 : 0}
      aria-current={isCurrent ? 'true' : undefined}
      aria-disabled={unavailable || undefined}
      aria-label={statusLabel}
      onClick={activate}
      onKeyDown={event => {
        if (measure || unavailable) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
      onDoubleClick={event => event.stopPropagation()}
      onContextMenu={measure ? undefined : onContextMenu}
      onPointerDown={measure ? undefined : onPointerDown}
      className={`group relative flex items-center gap-0.5 h-6 pl-2 pr-1 rounded text-[13px] flex-shrink-0 select-none transition-[colors,opacity,box-shadow,transform] duration-150 cursor-default [&_button]:cursor-default
        ${
          dragging
            ? 'z-[1] bg-bg-hover text-fg opacity-55 shadow-sm ring-1 ring-inset ring-accent/50 scale-[0.98]'
            : isCurrent
            ? 'bg-bg-active text-fg'
            : unavailable
            ? 'text-fg-dim'
            : 'text-fg-muted hover:text-fg hover:bg-bg-hover'
        }`}
    >
      {isCurrent && (
        <span className="pointer-events-none absolute inset-x-1 bottom-0 h-[2px] rounded bg-brand" aria-hidden />
      )}
      {unavailable ? (
        <span className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
          <AlertTriangle size={12} className="text-warn" />
        </span>
      ) : (
        <span className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
          <Folder size={12} className={isCurrent ? 'text-brand' : 'text-accent'} />
        </span>
      )}
      <span className="truncate max-w-[140px]">{project.name}</span>
      <ProjectIndicatorMarks project={project} indicators={indicators} isCurrent={isCurrent} />
      {project.ephemeral && !unavailable && (
        <Tooltip label={t('在文件管理器中打开')} side="bottom" wrapperClassName="inline-flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-label={t('在文件管理器中打开')}
            className="inline-flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-fg-dim hover:text-fg w-4 h-4"
            onClick={event => {
              event.stopPropagation()
              onOpenInExplorer()
            }}
          >
            <ExternalLink size={12} />
          </button>
        </Tooltip>
      )}
      {unavailable ? (
        <>
          <Tooltip label={t('重新定位项目')} side="bottom" wrapperClassName="inline-flex flex-shrink-0 items-center">
            <button
              type="button"
              aria-label={t('重新定位项目')}
              className="inline-flex items-center justify-center text-warn hover:text-fg w-4 h-4"
              onClick={event => {
                event.stopPropagation()
                onRelocate()
              }}
            >
              <LocateFixed size={12} />
            </button>
          </Tooltip>
          <Tooltip label={t('移除项目')} side="bottom" wrapperClassName="inline-flex flex-shrink-0 items-center">
            <button
              type="button"
              aria-label={t('移除项目')}
              className="inline-flex items-center justify-center text-fg-dim hover:text-danger w-4 h-4"
              onClick={event => {
                event.stopPropagation()
                onRemove()
              }}
            >
              <X size={12} />
            </button>
          </Tooltip>
        </>
      ) : (
        <Tooltip label={t('从顶栏隐藏')} side="bottom" wrapperClassName="inline-flex flex-shrink-0 items-center">
          <button
            type="button"
            aria-label={t('从顶栏隐藏')}
            className="inline-flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-fg-dim hover:text-danger w-4 h-4"
            onClick={event => {
              event.stopPropagation()
              onRemove()
            }}
          >
            <X size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
