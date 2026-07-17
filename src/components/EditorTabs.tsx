import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { X, Circle, ChevronDown, Copy, ExternalLink, Eye, Pencil, XSquare, CopyX, Files, LocateFixed, AlertTriangle, RotateCw, LoaderCircle, GitCompare } from 'lucide-react'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import { getFileIcon } from '../utils/fileIcons'
import { copyToClipboard } from '../utils/fileReferences'
import { safeInvoke } from '../lib/tauri'
import { openGitCompareWithHead } from '../lib/gitCompare'
import { gitStatusColorClass, gitStatusGlyph } from '../lib/gitStatus'
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

  if (tabs.length === 0) return null

  const copyPath = async (path: string) => {
    try {
      await copyToClipboard(path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (e) {
      useProjectStore.getState().pushToast('error', t('复制路径失败: {error}', { error: String(e) }))
    }
  }

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
      // Refresh the owning project's tree so the sidebar reflects the rename.
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
    void revealFileInTree(path)
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
      action: () => copyPath(tab.path),
    },
    {
      label: t('复制文件名'),
      icon: <Copy size={14} />,
      action: () => copyFileName(tab.path),
    },
    {
      label: t('在文件管理器中显示'),
      icon: <ExternalLink size={14} />,
      action: () => revealPath(tab.path),
    },
    ...(tab.kind === 'diff'
      ? []
      : [
          {
            label: t('重命名'),
            icon: <Pencil size={14} />,
            separatorBefore: true,
            action: () => renameTab(tab),
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

  return (
    <>
    <div className="ui-font-scaled h-[var(--tab-height)] flex bg-bg-deep border-b border-border flex-shrink-0">
      <div className="flex flex-1 min-w-0 overflow-x-auto">
        {tabs.map(tab => {
          const active = tab.id === activeTabId
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
            <div
              key={tab.id}
              className={`group relative flex items-center gap-2 pl-3 pr-2 h-full cursor-pointer border-r border-border whitespace-nowrap transition-colors
                ${active ? 'bg-tab-active text-fg' : 'bg-tab-inactive text-fg-muted hover:bg-bg-elevated hover:text-fg'}
                ${isOpenErrorTab(tab) && !active ? 'text-warn/90' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={event => {
                if (event.button !== 1) return
                event.preventDefault()
                void closeOne(tab)
              }}
              onMouseDown={event => {
                // Prevent middle-click auto-scroll.
                if (event.button === 1) event.preventDefault()
              }}
              onContextMenu={(event: ReactMouseEvent) => {
                event.preventDefault()
                event.stopPropagation()
                if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
                setContextMenu({ x: event.clientX, y: event.clientY, tab })
              }}
            >
              {active && (
                <span className="absolute top-0 left-0 right-0 h-[2px] bg-accent" aria-hidden="true" />
              )}
              {Icon && <Icon size={15} className={iconClass} />}
              <span
                className={`text-[13px] ${isOpenErrorTab(tab) ? 'italic' : ''} ${!isOpenErrorTab(tab) && tab.kind !== 'diff' && gitColor ? gitColor : ''}`}
              >
                {tab.name}
              </span>
              {tab.kind !== 'diff' && gitGlyph && (
                <span className={`text-[11px] font-medium ${gitColor}`} title={gitStatus ?? undefined}>
                  {gitGlyph}
                </span>
              )}
              <button
                className="ml-1 flex items-center justify-center w-4 h-4 rounded hover:bg-bg-active"
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
      <Tooltip label={t('显示所有打开的文件')} side="bottom">
        <button
          type="button"
          className="flex h-full w-8 flex-shrink-0 items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg"
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect()
            setOverflowMenu({ x: rect.right - 220, y: rect.bottom + 2 })
          }}
        >
          <ChevronDown size={14} />
        </button>
      </Tooltip>
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
