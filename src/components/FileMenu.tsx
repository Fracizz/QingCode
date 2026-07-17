import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AppWindow,
  Clock,
  FileDown,
  FilePlus,
  FolderOpen,
  LogOut,
  Save,
  SaveAll,
  X,
} from 'lucide-react'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { openNewAppWindow } from '../lib/appWindow'
import { getAutoSaveSettings, isAutoSaveEnabled } from '../lib/autoSave'
import {
  AUTO_SAVE_SETTINGS_EVENT,
  loadEffectiveAutoSaveSettings,
  saveScopedAutoSaveSettings,
} from '../lib/autoSaveSettings'
import { isTauri } from '../lib/tauri'
import { useI18n } from '../lib/i18n'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'

export default function FileMenu({ onExit }: { onExit: () => void | Promise<void> }) {
  const { t } = useI18n()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [autoSaveOn, setAutoSaveOn] = useState(() => isAutoSaveEnabled())

  const currentProject = useProjectStore(s => s.currentProject)
  const recentFiles = useProjectStore(s => s.recentFiles)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const pushToast = useProjectStore(s => s.pushToast)
  const requestNewFile = useUIStore(s => s.requestNewFile)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  const openFile = useEditorStore(s => s.openFile)
  const saveFile = useEditorStore(s => s.saveFile)
  const saveAs = useEditorStore(s => s.saveAs)
  const closeTab = useEditorStore(s => s.closeTab)

  useEffect(() => {
    void loadEffectiveAutoSaveSettings(currentProject).then(settings => {
      setAutoSaveOn(settings.mode !== 'off')
    })
  }, [currentProject])

  useEffect(() => {
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail && typeof detail === 'object' && 'mode' in detail) {
        setAutoSaveOn((detail as { mode: string }).mode !== 'off')
      } else {
        setAutoSaveOn(isAutoSaveEnabled())
      }
    }
    window.addEventListener(AUTO_SAVE_SETTINGS_EVENT, onSettingsChanged)
    return () => window.removeEventListener(AUTO_SAVE_SETTINGS_EVENT, onSettingsChanged)
  }, [])

  const closeMenu = () => setMenu(null)

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (menu) {
      closeMenu()
      return
    }
    setAutoSaveOn(isAutoSaveEnabled())
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 2 })
  }

  const toggleAutoSave = async () => {
    const current = getAutoSaveSettings()
    const nextMode = current.mode === 'off' ? 'afterDelay' : 'off'
    setAutoSaveOn(nextMode !== 'off')
    try {
      await saveScopedAutoSaveSettings('global', { mode: nextMode, delay: current.delay })
    } catch (error) {
      setAutoSaveOn(current.mode !== 'off')
      pushToast('error', t('保存自动保存设置失败: {error}', { error: String(error) }))
    }
  }

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? null
  const canSave =
    !!activeTab &&
    !activeTab.openError &&
    activeTab.viewMode !== 'view' &&
    activeTab.content !== undefined
  const dirtyCount = useEditorStore(s => {
    let count = s.tabs.filter(tab => tab.dirty).length
    for (const session of Object.values(s.projectSessions)) {
      count += session.tabs.filter(tab => tab.dirty).length
    }
    return count
  })

  const items: ContextMenuItem[] = [
    {
      label: t('新建文件'),
      icon: <FilePlus size={14} />,
      action: () => {
        if (!currentProject) {
          pushToast('info', t('请先选择或添加项目'))
          return
        }
        requestNewFile()
      },
    },
    {
      label: t('新建窗口'),
      icon: <AppWindow size={14} />,
      action: () => {
        if (!isTauri()) {
          pushToast('error', t('当前环境无法新建窗口'))
          return
        }
        void openNewAppWindow().catch(e => {
          pushToast('error', t('新建窗口失败: {error}', { error: String(e) }))
        })
      },
    },
    {
      label: t('打开文件夹'),
      icon: <FolderOpen size={14} />,
      separatorBefore: true,
      action: () => void addProjectFromDialog(),
    },
    ...recentFiles.slice(0, 10).map((file, index) => ({
      label: file.path.split(/[/\\]/).pop() || file.path,
      icon: <Clock size={14} />,
      separatorBefore: index === 0,
      action: () => void openFile(file.path),
    })),
    {
      label: t('保存'),
      icon: <Save size={14} />,
      shortcut: 'Ctrl+S',
      separatorBefore: true,
      disabled: !canSave,
      action: () => {
        if (activeTabId) void saveFile(activeTabId)
      },
    },
    {
      label: t('另存为'),
      icon: <FileDown size={14} />,
      disabled: !canSave,
      action: () => {
        if (activeTabId) void saveAs(activeTabId)
      },
    },
    {
      label: t('全部保存'),
      icon: <SaveAll size={14} />,
      disabled: dirtyCount === 0,
      action: async () => {
        const dirtyTabs = useEditorStore.getState().getAllTabs().filter(tab => tab.dirty)
        await Promise.all(dirtyTabs.map(tab => saveFile(tab.id)))
      },
    },
    {
      label: t('自动保存'),
      checked: autoSaveOn,
      separatorBefore: true,
      action: () => void toggleAutoSave(),
    },
    {
      label: t('关闭编辑器'),
      icon: <X size={14} />,
      separatorBefore: true,
      disabled: !activeTab,
      action: async () => {
        if (!activeTab) return
        if (await confirmDiscardTabs([activeTab], '关闭文件')) closeTab(activeTab.id)
      },
    },
    {
      label: t('退出'),
      icon: <LogOut size={14} />,
      separatorBefore: true,
      action: () => void onExit(),
    },
  ]

  return (
    <>
      <button
        type="button"
        aria-label={t('文件')}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        className={`flex h-6 items-center rounded px-2 text-[12px] transition-colors
          ${menu ? 'bg-bg-active text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'}`}
        onPointerDown={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onClick={openMenu}
      >
        {t('文件')}
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />
      )}
    </>
  )
}
