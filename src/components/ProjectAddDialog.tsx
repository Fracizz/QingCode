import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  AlertTriangle,
  Check,
  FilePlus2,
  Folder,
  FolderOpen,
  ListChecks,
} from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { relocateProjectWithDialog } from '../utils/projectActions'
import type { Project } from '../types'

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const orderA = a.sort_order ?? 0
    const orderB = b.sort_order ?? 0
    if (orderA !== orderB) return orderA - orderB
    return (b.last_opened_at ?? 0) - (a.last_opened_at ?? 0)
  })
}

interface Props {
  open: boolean
  onClose: () => void
}

/** Compact project picker — lighter than ProjectManager, opened from title-bar +. */
export default function ProjectAddDialog({ open, onClose }: Props) {
  const { t } = useI18n()
  const allProjects = useProjectStore(s => s.projects)
  const currentProject = useProjectStore(s => s.currentProject)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const switchProject = useProjectStore(s => s.switchProject)
  const addEmptyProject = useProjectStore(s => s.addEmptyProject)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const unhideProject = useProjectStore(s => s.unhideProject)
  const setView = useUIStore(s => s.setView)
  const openProjectManager = useUIStore(s => s.openProjectManager)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [addingEmpty, setAddingEmpty] = useState(false)

  const projects = useMemo(() => sortProjects(allProjects), [allProjects])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    )
  }, [projects, query])

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setQuery('')
      setActiveIndex(0)
    })
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    queueMicrotask(() =>
      setActiveIndex(i => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1))),
    )
  }, [filtered.length])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-project-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open) return null

  const selectProject = async (project: Project) => {
    onClose()
    setView('explorer')
    if (project.hidden) await unhideProject(project.id)
    if (unavailableProjectIds.includes(project.id)) {
      void relocateProjectWithDialog(project.id)
      return
    }
    await switchProject(project)
  }

  const handleOpenFolder = () => {
    onClose()
    setView('explorer')
    void addProjectFromDialog()
  }

  const handleAddEmpty = async () => {
    if (addingEmpty) return
    onClose()
    setAddingEmpty(true)
    setView('explorer')
    try {
      await addEmptyProject()
    } finally {
      setAddingEmpty(false)
    }
  }

  const handleManage = () => {
    onClose()
    openProjectManager()
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(i => (filtered.length === 0 ? 0 : (i + 1) % filtered.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(i =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      )
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = filtered[activeIndex]
      if (selected) void selectProject(selected)
      else if (filtered.length === 0) handleOpenFolder()
    }
  }

  return (
    <ModalOverlay onDismiss={onClose} zIndex="z-[110]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-add-title"
        aria-describedby="project-add-description"
        className="ui-font-scaled modal-content-enter relative flex w-full max-w-[340px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
        onPointerDown={event => event.stopPropagation()}
      >
        <h2 id="project-add-title" className="sr-only">
          {t('选择项目')}
        </h2>
        <p id="project-add-description" className="sr-only">
          {t('从已添加项目中切换，或打开文件夹添加项目。')}
        </p>
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-2.5 py-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('选择项目…')}
            aria-controls="project-add-list"
            className="modal-search-input"
          />
          <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] leading-none text-fg-dim sm:inline">
            Esc
          </kbd>
        </div>

        <div
          id="project-add-list"
          ref={listRef}
          role="listbox"
          aria-label={t('选择项目')}
          className="max-h-[min(240px,36vh)] overflow-y-auto py-0.5"
        >
          {filtered.length === 0 ? (
            <p className="text-ui-sm px-3 py-5 text-center text-fg-dim">
              {projects.length === 0
                ? t('暂无项目，可打开文件夹添加')
                : t('没有匹配的项目')}
            </p>
          ) : (
            filtered.map((project, index) => {
              const unavailable = unavailableProjectIds.includes(project.id)
              const isCurrent = currentProject?.id === project.id
              const active = index === activeIndex
              return (
                <Tooltip
                  key={project.id}
                  label={project.path}
                  side="right"
                  wrapperClassName="block w-full"
                >
                  <button
                    type="button"
                    role="option"
                    aria-label={`${project.name} — ${project.path}`}
                    aria-selected={active || isCurrent}
                    data-project-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void selectProject(project)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors
                      ${active ? 'bg-bg-active text-fg' : 'text-fg hover:bg-bg-hover'}`}
                  >
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                      {unavailable ? (
                        <AlertTriangle size={13} className="text-warn" />
                      ) : isCurrent ? (
                        <Check size={12} className="text-accent" />
                      ) : (
                        <Folder size={13} className="text-accent" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
                    {project.hidden ? (
                      <span className="flex-shrink-0 text-[10px] text-fg-dim">{t('已隐藏')}</span>
                    ) : null}
                  </button>
                </Tooltip>
              )
            })
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-0.5 border-t border-border px-1.5 py-1">
          <button
            type="button"
            onClick={handleOpenFolder}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <FolderOpen size={13} />
            {t('打开文件夹')}
          </button>
          <Tooltip
            label={t('退出后从列表移除')}
            side="top"
            wrapperClassName="inline-flex flex-1 min-w-0"
          >
            <button
              type="button"
              disabled={addingEmpty}
              onClick={() => void handleAddEmpty()}
              aria-label={`${t('临时项目')} — ${t('退出后从列表移除')}`}
              className="inline-flex w-full items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              <FilePlus2 size={13} />
              {t('临时项目')}
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={handleManage}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <ListChecks size={13} />
            {t('项目管理')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
