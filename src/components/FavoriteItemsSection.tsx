import { useEffect, useState, type DragEvent as ReactDragEvent, type MouseEvent } from 'react'
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File as FileIcon,
  Folder,
  Search,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import type { FavoriteItem, Project } from '../types'
import { favoriteAbsolutePath } from '../lib/favoriteItems'
import { useFavoriteStore } from '../store/favoriteStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useTerminalStore } from '../store/terminalStore'
import { useUIStore } from '../store/uiStore'
import { copyPathAction } from '../lib/copyFileActions'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import { useI18n } from '../lib/i18n'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import {
  EXPLORER_FAVORITES_ACTION_COL,
  EXPLORER_FAVORITES_INSET,
  EXPLORER_FAVORITES_ITEM_PL,
  EXPLORER_FAVORITES_ITEM_ROW,
  EXPLORER_FAVORITES_SECTION,
  EXPLORER_SUBSECTION_HEADER,
  EXPLORER_TREE_CHEVRON_COL,
} from './explorerLayout'

const FAVORITES_EXPANDED_KEY = 'qingcode:explorer-favorites-expanded'
const EMPTY_FAVORITES: FavoriteItem[] = []

function initialExpanded(): boolean {
  try {
    return localStorage.getItem(FAVORITES_EXPANDED_KEY) !== '0'
  } catch {
    return true
  }
}

function favoriteDisplayPath(item: FavoriteItem): string {
  return item.relativePath
}

export default function FavoriteItemsSection({ project }: { project: Project }) {
  const { t } = useI18n()
  const items = useFavoriteStore(state => state.itemsByProject[project.id] ?? EMPTY_FAVORITES)
  const loadProjectFavorites = useFavoriteStore(state => state.loadProjectFavorites)
  const removeFavorite = useFavoriteStore(state => state.removeFavorite)
  const reorderFavorite = useFavoriteStore(state => state.reorderFavorite)
  const revealFileInTree = useProjectStore(state => state.revealFileInTree)
  const addTerminal = useTerminalStore(state => state.addTerminal)
  const requestSearch = useUIStore(state => state.requestSearch)
  const [expanded, setExpanded] = useState(initialExpanded)
  const [draggedPath, setDraggedPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    path: string
    position: 'before' | 'after'
  } | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: FavoriteItem
  } | null>(null)

  useEffect(() => {
    void loadProjectFavorites(project).catch(error => {
      useProjectStore.getState().pushToast(
        'error',
        t('加载收藏夹失败: {error}', { error: String(error) }),
      )
    })
  }, [loadProjectFavorites, project, t])

  // Do not mount a loading-only section for projects without cached favorites.
  // Its brief appearance shifted the whole file tree down and back up on startup.
  if (items.length === 0) return null

  const toggleExpanded = () => {
    const next = !expanded
    setExpanded(next)
    try {
      localStorage.setItem(FAVORITES_EXPANDED_KEY, next ? '1' : '0')
    } catch {
      // Persistence is optional in browser preview/private storage contexts.
    }
  }

  const activate = (item: FavoriteItem) => {
    void (async () => {
      if (!item.available) {
        await loadProjectFavorites(project, { force: true })
        const refreshed = useFavoriteStore
          .getState()
          .itemsByProject[project.id]?.find(entry => entry.relativePath === item.relativePath)
        if (!refreshed?.available) return
        item = refreshed
      }
      const path = favoriteAbsolutePath(project.path, item.relativePath)
      if (item.kind === 'directory') {
        await revealFileInTree(path, { force: true })
      } else {
        await useEditorStore.getState().openFile(path)
      }
    })().catch(error => {
      useProjectStore.getState().pushToast('error', String(error))
    })
  }

  const revealInTree = (item: FavoriteItem) => {
    if (!item.available) return
    void revealFileInTree(favoriteAbsolutePath(project.path, item.relativePath), { force: true })
  }

  const revealInFileManager = async (item: FavoriteItem) => {
    if (!item.available) return
    const path = favoriteAbsolutePath(project.path, item.relativePath)
    try {
      if (item.kind === 'directory') await openPath(path)
      else await revealItemInDir(path)
    } catch (error) {
      useProjectStore.getState().pushToast(
        'error',
        t('在文件管理器中打开失败: {error}', { error: String(error) }),
      )
    }
  }

  const handleRemove = (item: FavoriteItem, event?: MouseEvent) => {
    event?.stopPropagation()
    void removeFavorite(project, item.relativePath).catch(error => {
      useProjectStore.getState().pushToast(
        'error',
        t('更新收藏夹失败: {error}', { error: String(error) }),
      )
    })
  }

  const menuItems = (item: FavoriteItem): ContextMenuItem[] => {
    const path = favoriteAbsolutePath(project.path, item.relativePath)
    return [
      ...(item.kind === 'file'
        ? [
            {
              label: t('打开文件'),
              icon: <FileIcon size={14} />,
              disabled: !item.available,
              action: () => activate(item),
            },
          ]
        : [
            {
              label: t('在文件树中定位'),
              icon: <Folder size={14} />,
              disabled: !item.available,
              action: () => revealInTree(item),
            },
            {
              label: t('在此处打开终端'),
              icon: <TerminalIcon size={14} />,
              disabled: !item.available,
              action: () => void addTerminal(path, project.id),
            },
            {
              label: t('在此文件夹中搜索'),
              icon: <Search size={14} />,
              disabled: !item.available,
              action: () => requestSearch(path),
            },
          ]),
      ...(item.kind === 'file'
        ? [
            {
              label: t('在文件树中定位'),
              icon: <Folder size={14} />,
              disabled: !item.available,
              action: () => revealInTree(item),
            },
          ]
        : []),
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        action: () => void copyPathAction(path),
      },
      {
        label: item.kind === 'directory' ? t('在文件管理器中打开') : t('在文件管理器中显示'),
        icon: <ExternalLink size={14} />,
        disabled: !item.available,
        action: () => void revealInFileManager(item),
      },
      {
        label: t('取消收藏'),
        icon: <X size={14} />,
        separatorBefore: true,
        action: () => handleRemove(item),
      },
    ]
  }

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, targetPath: string) => {
    const sourcePath = draggedPath || event.dataTransfer.getData('text/plain')
    if (!sourcePath || sourcePath === targetPath) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTarget(current =>
      current?.path === targetPath && current.position === position
        ? current
        : { path: targetPath, position },
    )
  }

  const clearDrag = () => {
    setDraggedPath(null)
    setDropTarget(null)
  }

  return (
    <section aria-label={t('收藏夹')} className={EXPLORER_FAVORITES_SECTION}>
      <button
        type="button"
        className={`${EXPLORER_FAVORITES_INSET} ${EXPLORER_SUBSECTION_HEADER}${
          expanded ? ' border-b border-border/35' : ''
        }`}
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span className={EXPLORER_TREE_CHEVRON_COL} aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <Bookmark size={13} className="shrink-0 text-warn" />
        <span className="min-w-0 flex-1 truncate text-left leading-none">{t('收藏夹')}</span>
        <span className="shrink-0 tabular-nums text-[10px] font-normal text-fg-dim">{items.length}</span>
      </button>
      {expanded && (
        <div className={`${EXPLORER_FAVORITES_INSET} max-h-[35vh] overflow-y-auto overscroll-y-contain pb-1.5 pt-0.5`}>
          {items.map(item => {
            const path = favoriteAbsolutePath(project.path, item.relativePath)
            const displayPath = favoriteDisplayPath(item)
            const tooltip = item.available ? path : `${path}\n${t('收藏项暂不可用')}`
            return (
              <div
                key={item.relativePath}
                role="button"
                tabIndex={0}
                aria-disabled={!item.available}
                draggable={item.available}
                className={`group relative ${EXPLORER_FAVORITES_ITEM_ROW} ${EXPLORER_FAVORITES_ITEM_PL} ${
                  item.available
                    ? 'cursor-grab text-tree-fg active:cursor-grabbing hover:bg-bg-hover/45'
                    : 'cursor-default text-fg-dim opacity-60'
                } ${draggedPath === item.relativePath ? 'opacity-40' : ''}`}
                onClick={() => activate(item)}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  activate(item)
                }}
                onContextMenu={(event: MouseEvent) => {
                  if (!shouldShowAppContextMenu(event)) return
                  event.stopPropagation()
                  setContextMenu({ x: event.clientX, y: event.clientY, item })
                }}
                onDragStart={event => {
                  if (!item.available) {
                    event.preventDefault()
                    return
                  }
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', item.relativePath)
                  setDraggedPath(item.relativePath)
                }}
                onDragOver={event => handleDragOver(event, item.relativePath)}
                onDrop={event => {
                  event.preventDefault()
                  const sourcePath = draggedPath || event.dataTransfer.getData('text/plain')
                  if (sourcePath && sourcePath !== item.relativePath) {
                    const rect = event.currentTarget.getBoundingClientRect()
                    const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                    void reorderFavorite(project, sourcePath, item.relativePath, position).catch(
                      error => {
                        useProjectStore.getState().pushToast(
                          'error',
                          t('更新收藏夹失败: {error}', { error: String(error) }),
                        )
                      },
                    )
                  }
                  clearDrag()
                }}
                onDragEnd={clearDrag}
              >
                {dropTarget?.path === item.relativePath && draggedPath !== item.relativePath && (
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-x-8 z-10 h-0.5 rounded bg-accent ${
                      dropTarget.position === 'before' ? 'top-0' : 'bottom-0'
                    }`}
                  />
                )}
                <span className={`${EXPLORER_TREE_CHEVRON_COL} pt-0.5`} aria-hidden="true" />
                {item.kind === 'directory' ? (
                  <Folder size={15} className="mt-0.5 shrink-0 text-accent" />
                ) : (
                  <FileIcon size={14} className="mt-0.5 shrink-0 text-fg-muted" />
                )}
                <Tooltip
                  label={tooltip}
                  side="right"
                  wrapperClassName="min-w-0 flex-1 overflow-hidden pt-0.5"
                >
                  <span className="block min-w-0 break-all leading-snug line-clamp-2">
                    {displayPath}
                  </span>
                </Tooltip>
                <span className={`${EXPLORER_FAVORITES_ACTION_COL} pt-0.5`}>
                  <Tooltip label={t('取消收藏')} side="bottom">
                    <button
                      type="button"
                      aria-label={t('取消收藏')}
                      className="rounded p-0.5 text-fg-dim opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                      onClick={event => handleRemove(item, event)}
                    >
                      <X size={13} />
                    </button>
                  </Tooltip>
                </span>
              </div>
            )
          })}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu.item)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </section>
  )
}
