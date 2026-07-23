import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { X, Circle, ChevronDown, Copy, ExternalLink, Eye, Pencil, XSquare, CopyX, Files, LocateFixed, AlertTriangle, RotateCw, LoaderCircle, GitCompare } from 'lucide-react'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { getFileIcon } from '../utils/fileIcons'
import { copyPathAction, copyRelativePathAction } from '../lib/copyFileActions'
import { COPY_RELATIVE_PATH_SHORTCUT } from '../lib/shortcuts'
import { safeInvoke } from '../lib/tauri'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import { openGitCompareWithHead } from '@/lib/git/gitCompare'
import { copyToClipboard } from '../utils/fileReferences'
import { gitStatusColorClass, gitStatusGlyph } from '@/lib/git/gitStatus'
import {
  EDITOR_TAB_OVERFLOW_BTN_W,
  MAX_OPEN_EDITOR_TABS,
  pickVisibleTabIndices,
} from '../lib/editorTabsLayout'
import { promptDialog, validateEntryName } from '../store/promptStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Tooltip from './Tooltip'
import type { EditorTab } from '../types'
import { useI18n } from '../lib/i18n'
import { isLoadingTab, isOpenErrorTab, isViewOnlyTab } from '../lib/openFileError'

function parentPath(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 ? path.slice(0, separator) : path
}

function fileName(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator >= 0 ? path.slice(separator + 1) : path
}

function TabChrome({ tab }: { tab: EditorTab }) {
  const loading = isLoadingTab(tab)
  const viewOnly = isViewOnlyTab(tab)
  const gitStatus = useGitStatusStore.getState().statusFor(tab.path)
  const gitGlyph = gitStatusGlyph(gitStatus)
  const gitColor = gitStatusColorClass(gitStatus)
  const Icon = isOpenErrorTab(tab)
    ? AlertTriangle
    : loading
      ? LoaderCircle
      : tab.kind === 'diff'
        ? GitCompare
        : viewOnly
          ? Eye
          : getFileIcon(tab.name)
  const iconClass = isOpenErrorTab(tab)
    ? 'flex-shrink-0 text-warn'
    : loading
      ? 'flex-shrink-0 text-accent animate-spin'
      : tab.kind === 'diff' || viewOnly
        ? 'flex-shrink-0 text-accent opacity-90'
        : 'flex-shrink-0 opacity-80'

  return (
    <>
      {Icon && <Icon size={15} className={iconClass} />}
      <span
        className={`text-[13px] ${isOpenErrorTab(tab) ? 'italic' : ''} ${!isOpenErrorTab(tab) && tab.kind !== 'diff' && gitColor ? gitColor : ''}`}
      >
        {tab.name}
      </span>
      {tab.kind !== 'diff' && gitGlyph && (
        <span className={`text-[11px] font-medium ${gitColor}`}>{gitGlyph}</span>
      )}
    </>
  )
}

export default function EditorTabs() {
  const { t } = useI18n()
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const setActiveTab = useEditorStore(s => s.setActiveTab)
  const closeTab = useEditorStore(s => s.closeTab)
  const retryOpenFile = useEditorStore(s => s.retryOpenFile)
  const closeOtherTabs = useEditorStore(s => s.closeOtherTabs)
  const closeTabsToRight = useEditorStore(s => s.closeTabsToRight)
  const closeAllTabs = useEditorStore(s => s.closeAllTabs)
  const reorderTabs = useEditorStore(s => s.reorderTabs)
  const renameEditorPath = useEditorStore(s => s.renamePath)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const setView = useUIStore(s => s.setView)
  useGitStatusStore(s => s.statusByPath)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    tab: EditorTab
  } | null>(null)
  const [overflowMenu, setOverflowMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [visibleIndices, setVisibleIndices] = useState<number[]>([])
  const stripRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const strip = stripRef.current
    const measure = measureRef.current
    if (!strip || !measure || tabs.length === 0) {
      setVisibleIndices([])
      return
    }

    const compute = () => {
      const widths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-tab-measure-id]'),
        el => el.offsetWidth,
      )
      if (widths.length !== tabs.length) {
        setVisibleIndices(tabs.map((_, i) => i))
        return
      }
      const activeIndex = Math.max(
        0,
        tabs.findIndex(tab => tab.id === activeTabId),
      )
      setVisibleIndices(
        pickVisibleTabIndices(widths, activeIndex, strip.clientWidth, EDITOR_TAB_OVERFLOW_BTN_W),
      )
    }

    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(strip)
    return () => ro.disconnect()
  }, [tabs, activeTabId])

  if (tabs.length === 0) return null

  const copyFileName = async (path: string) => {
    try {
      await copyToClipboard(fileName(path))
      useProjectStore.getState().pushToast('success', t('文件名已复制'))
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('复制文件名失败: {error}', { error: String(e) }))
    }
  }

  const revealPath = async (path: string) => {
    try {
      await revealItemInDir(path)
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('在文件管理器中显示失败: {error}', { error: String(e) }))
    }
  }

  const renameTab = async (tab: EditorTab) => {
    const name = await promptDialog({
      title: t('重命名'),
      message: t('文件新名称'),
      defaultValue: tab.name,
      validate: validateEntryName,
      confirmLabel: t('重命名'),
    })
    if (!name || name === tab.name) return
    try {
      const newPath = await safeInvoke<string>('重命名', 'rename_path', {
        path: tab.path,
        newName: name,
      })
      renameEditorPath(tab.path, newPath)
      const store = useProjectStore.getState()
      const norm = parentPath(tab.path).replace(/\\/g, '/')
      const project = store.projects.find(
        p => norm === p.path.replace(/\\/g, '/') || norm.startsWith(p.path.replace(/\\/g, '/') + '/')
      )
      if (project) {
        if (parentPath(tab.path) === project.path) await store.refreshProjectTree(project)
        else await store.expandProjectDir(project.id, parentPath(tab.path))
      }
      useProjectStore.getState().pushToast('success', t('已重命名为: {name}', { name }))
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('重命名失败: {error}', { error: String(e) }))
    }
  }

  const revealInSidebar = (path: string) => {
    setView('explorer')
    void revealFileInTree(path, { force: true })
  }

  const closeWithConfirm = async (tabsToClose: EditorTab[], close: () => void) => {
    if (await confirmDiscardTabs(tabsToClose, '关闭文件')) close()
  }

  const closeOne = (tab: EditorTab) => closeWithConfirm([tab], () => closeTab(tab.id))

  const closeOthers = (tab: EditorTab) =>
    closeWithConfirm(tabs.filter(candidate => candidate.id !== tab.id), () => closeOtherTabs(tab.id))

  const closeToRight = (tab: EditorTab) => {
    const index = tabs.findIndex(candidate => candidate.id === tab.id)
    return closeWithConfirm(index < 0 ? [] : tabs.slice(index + 1), () => closeTabsToRight(tab.id))
  }

  const closeAll = () => closeWithConfirm(tabs, closeAllTabs)

  const menuItems = (tab: EditorTab): ContextMenuItem[] => [
    ...(isOpenErrorTab(tab)
      ? [
          {
            label: t('重试'),
            icon: <RotateCw size={14} />,
            action: () => void retryOpenFile(tab.id),
          },
        ]
      : []),
    {
      label: t('关闭'),
      icon: <X size={14} />,
      action: () => closeOne(tab),
    },
    {
      label: t('关闭其它'),
      icon: <XSquare size={14} />,
      action: () => closeOthers(tab),
    },
    {
      label: t('关闭右侧'),
      icon: <CopyX size={14} />,
      action: () => closeToRight(tab),
    },
    {
      label: t('关闭全部'),
      icon: <Files size={14} />,
      action: closeAll,
    },
    {
      label: t('在资源管理器中定位'),
      icon: <LocateFixed size={14} />,
      separatorBefore: true,
      action: () => revealInSidebar(tab.path),
    },
    ...(tab.kind === 'diff'
      ? []
      : [
          {
            label: t('与 Git HEAD 比较'),
            icon: <GitCompare size={14} />,
            action: () => void openGitCompareWithHead(tab.path),
          } satisfies ContextMenuItem,
        ]),
    {
      label: t('复制路径'),
      icon: <Copy size={14} />,
      shortcut: 'Ctrl+Shift+C',
      action: () => void copyPathAction(tab.path),
    },
    {
      label: t('复制相对路径'),
      icon: <Copy size={14} />,
      shortcut: COPY_RELATIVE_PATH_SHORTCUT,
      action: () => void copyRelativePathAction(tab.path),
    },
    {
      label: t('复制文件名'),
      icon: <Copy size={14} />,
      action: () => void copyFileName(tab.path),
    },
    {
      label: t('在文件管理器中显示'),
      icon: <ExternalLink size={14} />,
      action: () => void revealPath(tab.path),
    },
    ...(tab.kind === 'diff'
      ? []
      : [
          {
            label: t('重命名'),
            icon: <Pencil size={14} />,
            separatorBefore: true,
            action: () => void renameTab(tab),
          } satisfies ContextMenuItem,
        ]),
  ]

  const overflowItems = (): ContextMenuItem[] =>
    tabs.map(tab => {
      const Icon = tab.kind === 'diff' ? GitCompare : getFileIcon(tab.path)
      return {
        label: tab.id === activeTabId ? `${tab.name} ●` : tab.name,
        icon: Icon ? <Icon size={14} /> : undefined,
        action: () => setActiveTab(tab.id),
      }
    })

  const indices = visibleIndices.length > 0 ? visibleIndices : tabs.map((_, i) => i)
  const hiddenCount = Math.max(0, tabs.length - indices.length)

  return (
    <>
      <div className="ui-font-scaled relative flex h-[var(--tab-height)] flex-shrink-0 border-b border-border bg-bg-deep">
        <div
          ref={stripRef}
          role="tablist"
          aria-label={t('显示所有打开的文件')}
          className="flex min-w-0 flex-1 overflow-hidden"
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            const current = indices.findIndex(i => tabs[i]?.id === activeTabId)
            if (current < 0 || indices.length === 0) return
            event.preventDefault()
            const delta = event.key === 'ArrowRight' ? 1 : -1
            const next = indices[(current + delta + indices.length) % indices.length]
            const nextTab = tabs[next]
            if (nextTab) setActiveTab(nextTab.id)
          }}
        >
          {indices.map((index, visiblePos) => {
            const tab = tabs[index]
            if (!tab) return null
            const active = tab.id === activeTabId
            const showDivider = visiblePos < indices.length - 1
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                draggable
                className={`group relative flex h-full cursor-pointer items-center gap-2 whitespace-nowrap pl-3 pr-2 transition-colors
                ${active ? 'bg-tab-active text-fg' : 'bg-tab-inactive text-fg-muted hover:bg-bg-elevated hover:text-fg'}
                ${isOpenErrorTab(tab) && !active ? 'text-warn/90' : ''}
                ${dropIndex === index && dragIndex !== index ? 'ring-1 ring-inset ring-accent/60' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveTab(tab.id)
                  }
                }}
                onDragStart={event => {
                  setDragIndex(index)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', tab.id)
                }}
                onDragOver={event => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dragIndex !== null && dragIndex !== index) setDropIndex(index)
                }}
                onDragLeave={() => {
                  if (dropIndex === index) setDropIndex(null)
                }}
                onDrop={event => {
                  event.preventDefault()
                  if (dragIndex !== null && dragIndex !== index) reorderTabs(dragIndex, index)
                  setDragIndex(null)
                  setDropIndex(null)
                }}
                onDragEnd={() => {
                  setDragIndex(null)
                  setDropIndex(null)
                }}
                onAuxClick={event => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  void closeOne(tab)
                }}
                onMouseDown={event => {
                  if (event.button === 1) event.preventDefault()
                }}
                onContextMenu={(event: ReactMouseEvent) => {
                  if (!shouldShowAppContextMenu(event)) return
                  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
                  setContextMenu({ x: event.clientX, y: event.clientY, tab })
                }}
              >
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-brand" aria-hidden="true" />
                )}
                {showDivider && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-0 top-1/2 h-[80%] w-[0.8px] -translate-y-1/2 bg-border-strong"
                  />
                )}
                <TabChrome tab={tab} />
                <button
                  type="button"
                  aria-label={t('关闭文件')}
                  className="ml-1 flex h-4 w-4 items-center justify-center rounded hover:bg-bg-active"
                  onClick={e => {
                    e.stopPropagation()
                    void closeOne(tab)
                  }}
                >
                  {tab.dirty ? (
                    <Circle size={9} className="dirty-pulse text-warn group-hover:hidden" fill="currentColor" />
                  ) : null}
                  <X
                    size={14}
                    className={tab.dirty ? 'hidden group-hover:block' : 'opacity-60 group-hover:opacity-100'}
                  />
                </button>
              </div>
            )
          })}
        </div>
        <Tooltip
          label={
            hiddenCount > 0
              ? t('显示所有打开的文件（{hidden} 个已折叠，最多 {max}）', {
                  hidden: hiddenCount,
                  max: MAX_OPEN_EDITOR_TABS,
                })
              : t('显示所有打开的文件（最多 {max} 个）', { max: MAX_OPEN_EDITOR_TABS })
          }
          side="bottom"
        >
          <button
            type="button"
            aria-label={t('显示所有打开的文件')}
            className="relative flex h-full w-8 flex-shrink-0 items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg"
            onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect()
              setOverflowMenu({ x: rect.right - 220, y: rect.bottom + 2 })
            }}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-1/2 h-[80%] w-[0.8px] -translate-y-1/2 bg-border-strong"
            />
            <ChevronDown size={14} />
            {hiddenCount > 0 && (
              <span className="absolute bottom-0.5 right-0.5 min-w-[12px] h-[12px] rounded-sm bg-accent px-0.5 text-center text-[9px] font-semibold leading-[12px] text-white">
                {hiddenCount > 99 ? '99+' : hiddenCount}
              </span>
            )}
          </button>
        </Tooltip>

        {/* Hidden measure layer: natural tab widths for overflow fitting. */}
        <div
          ref={measureRef}
          className="pointer-events-none absolute left-0 top-0 -z-10 flex h-[var(--tab-height)] opacity-0"
          aria-hidden="true"
        >
          {tabs.map(tab => (
            <div
              key={`measure-${tab.id}`}
              data-tab-measure-id={tab.id}
              className="flex h-full items-center gap-2 whitespace-nowrap pl-3 pr-2"
            >
              <TabChrome tab={tab} />
              <span className="ml-1 h-4 w-4 flex-shrink-0" />
            </div>
          ))}
        </div>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu.tab)}
          onClose={() => setContextMenu(null)}
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
