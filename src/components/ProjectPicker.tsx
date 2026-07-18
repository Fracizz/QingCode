import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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
} from 'lucide-react'
import { openPath } from '@tauri-apps/plugin-opener'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import {
  relocateProjectWithDialog,
  renameProjectWithPrompt,
} from '../utils/projectActions'
import Tooltip from './Tooltip'
import WorkspaceMenu from './WorkspaceMenu'
import type { Project } from '../types'
import { useI18n } from '../lib/i18n'

const CHIP_GAP = 4
const ADD_BTN_W = 28
const OVERFLOW_BTN_W = 28

export default function ProjectPicker() {
  const { t } = useI18n()
  const allProjects = useProjectStore(s => s.projects)
  const projects = allProjects.filter(p => !p.hidden)
  const currentProject = useProjectStore(s => s.currentProject)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const switchProject = useProjectStore(s => s.switchProject)
  const addEmptyProject = useProjectStore(s => s.addEmptyProject)
  const hideProject = useProjectStore(s => s.hideProject)
  const setView = useUIStore(s => s.setView)
  const openProjectManager = useUIStore(s => s.openProjectManager)
  const openWorkspaceManager = useUIStore(s => s.openWorkspaceManager)

  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)

  const [visibleCount, setVisibleCount] = useState(projects.length)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({})
  const [addingEmpty, setAddingEmpty] = useState(false)

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
    closeDropdown()
    setView('explorer')
    await switchProject(project)
  }

  const handleAddEmpty = async () => {
    if (addingEmpty) return
    setAddingEmpty(true)
    setView('explorer')
    try {
      await addEmptyProject()
    } finally {
      setAddingEmpty(false)
    }
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

  const openOverflow = (event: ReactMouseEvent) => {
    event.stopPropagation()
    positionDropdown()
    setOverflowOpen(v => !v)
  }

  const visibleProjects = projects.slice(0, visibleCount)
  const overflowProjects = projects.slice(visibleCount)
  const hasOverflow = overflowProjects.length > 0

  return (
    <div className="relative overflow-hidden flex-1 flex items-center h-full min-w-0 gap-1">
      {/* Keep workspace control next to the file menu — not pushed to the far right. */}
      <WorkspaceMenu />

      {/* Visible chips — empty leftover width bubbles dblclick maximize to TitleBar */}
      <div ref={containerRef} className="flex-1 flex items-center h-full min-w-0 gap-1 overflow-hidden">
        {visibleProjects.map(project => (
          <Chip
            key={project.id}
            project={project}
            isCurrent={currentProject?.id === project.id}
            unavailable={unavailableProjectIds.includes(project.id)}
            onSwitch={() => void handleSwitch(project)}
            onRemove={() => handleRemove(project)}
            onRelocate={() => handleRelocate(project.id)}
            onOpenInExplorer={() => void handleOpenInExplorer(project.path)}
          />
        ))}

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

        <Tooltip label={t('新建临时项目')} side="bottom" wrapperClassName="flex-shrink-0">
          <button
            ref={addBtnRef}
            type="button"
            aria-label={t('新建临时项目')}
            disabled={addingEmpty}
            onClick={() => void handleAddEmpty()}
            onDoubleClick={event => event.stopPropagation()}
            className={`flex items-center justify-center h-6 w-7 rounded text-[13px] flex-shrink-0 transition-colors
              ${addingEmpty ? 'opacity-50 cursor-not-allowed' : 'text-fg-muted hover:text-fg hover:bg-bg-hover'}`}
          >
            <Plus size={14} />
          </button>
        </Tooltip>

        {projects.length === 0 && (
          <button
            type="button"
            onClick={() => void handleAddEmpty()}
            onDoubleClick={event => event.stopPropagation()}
            className="flex items-center h-6 px-2 rounded text-[13px] text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
          >
            {t('新建临时项目')}
          </button>
        )}
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
            isCurrent={currentProject?.id === project.id}
            unavailable={unavailableProjectIds.includes(project.id)}
            measure
            onSwitch={() => {}}
            onRemove={() => {}}
            onRelocate={() => {}}
            onOpenInExplorer={() => {}}
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
            onContextMenu={event => event.preventDefault()}
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
                    className={`group flex items-center gap-2 px-3 py-1.5 text-[13px] outline-none
                      ${
                        isCurrent
                          ? 'bg-bg-active text-fg'
                          : unavailable
                          ? 'text-fg-dim'
                          : 'text-fg hover:bg-bg-hover focus:bg-bg-active cursor-pointer'
                      }`}
                  >
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      {unavailable ? (
                        <AlertTriangle size={14} className="text-warn" />
                      ) : isCurrent ? (
                        <Check size={13} className="text-accent" />
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
                    <Tooltip label={t('从顶栏隐藏')} side="right" wrapperClassName="flex-shrink-0">
                      <button
                        type="button"
                        aria-label={t('从顶栏隐藏')}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-fg-dim hover:text-danger"
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

    </div>
  )
}

function Chip({
  project,
  isCurrent,
  unavailable,
  measure = false,
  onSwitch,
  onRemove,
  onRelocate,
  onOpenInExplorer,
}: {
  project: Project
  isCurrent: boolean
  unavailable: boolean
  measure?: boolean
  onSwitch: () => void
  onRemove: () => void
  onRelocate: () => void
  onOpenInExplorer: () => void
}) {
  const { t } = useI18n()
  return (
    <div
      data-chip-id={measure ? project.id : undefined}
      onClick={() => !unavailable && onSwitch()}
      onDoubleClick={event => event.stopPropagation()}
      className={`group flex items-center gap-1 h-6 pl-2 pr-1 rounded text-[13px] flex-shrink-0 select-none transition-colors
        ${
          isCurrent
            ? 'bg-bg-active text-fg'
            : unavailable
            ? 'text-fg-dim cursor-default'
            : 'text-fg-muted hover:text-fg hover:bg-bg-hover cursor-pointer'
        }`}
    >
      {unavailable ? (
        <span className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
          <AlertTriangle size={12} className="text-warn" />
        </span>
      ) : (
        <span className="inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
          <Folder size={12} className="text-accent" />
        </span>
      )}
      <span className="truncate max-w-[140px]">{project.name}</span>
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
