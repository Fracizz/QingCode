import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { X, Circle, Copy, ExternalLink, Pencil, XSquare, CopyX, Files, LocateFixed } from 'lucide-react'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { getFileIcon } from '../utils/fileIcons'
import { copyToClipboard } from '../utils/fileReferences'
import { safeInvoke } from '../lib/tauri'
import { promptDialog, validateEntryName } from '../store/promptStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import type { EditorTab } from '../types'
import { useI18n } from '../lib/i18n'

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
  const closeOtherTabs = useEditorStore(s => s.closeOtherTabs)
  const closeTabsToRight = useEditorStore(s => s.closeTabsToRight)
  const closeAllTabs = useEditorStore(s => s.closeAllTabs)
  const renameEditorPath = useEditorStore(s => s.renamePath)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const setView = useUIStore(s => s.setView)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    tab: EditorTab
  } | null>(null)

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
    {
      label: t('重命名'),
      icon: <Pencil size={14} />,
      separatorBefore: true,
      action: () => renameTab(tab),
    },
  ]

  return (
    <>
    <div className="ui-font-scaled h-[var(--tab-height)] flex bg-bg-deep border-b border-border overflow-x-auto flex-shrink-0">
        {tabs.map(tab => {
          const active = tab.id === activeTabId
          const Icon = getFileIcon(tab.name)
          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-2 pl-3 pr-2 h-full cursor-pointer border-r border-border whitespace-nowrap transition-colors
                ${active ? 'bg-tab-active text-fg' : 'bg-tab-inactive text-fg-muted hover:bg-bg-elevated hover:text-fg'}`}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(event: ReactMouseEvent) => {
                event.preventDefault()
                event.stopPropagation()
                if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
                setContextMenu({ x: event.clientX, y: event.clientY, tab })
              }}
            >
              {Icon && <Icon size={15} className="flex-shrink-0 opacity-80" />}
              <span className="text-[13px]">{tab.name}</span>
              <button
                className="ml-1 flex items-center justify-center w-4 h-4 rounded hover:bg-bg-active"
                onClick={e => {
                  e.stopPropagation()
                  void closeOne(tab)
                }}
              >
                {tab.dirty ? (
                  <Circle size={9} className="text-warn group-hover:hidden" fill="currentColor" />
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
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu.tab)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}
