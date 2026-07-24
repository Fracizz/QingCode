import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  Minus,
  Square,
  Copy,
  X,
  PanelBottom,
  PanelLeft,
  Columns3,
} from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { requestAppClose } from '../lib/appClose'
import { isTauri } from '../lib/tauri'
import { useProjectStore } from '../store/projectStore'
import AppIcon from './AppIcon'
import FileMenu from './FileMenu'
import Tooltip from './Tooltip'
import ProjectPicker from './ProjectPicker'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { translate, useI18n } from '../lib/i18n'
import {
  PANEL_LAYOUT_MENU_MODES,
  panelLayoutModeLabel,
  resolvePanelLayoutMode,
  type PanelLayoutMode,
} from '../lib/panelLayoutMode'
import { useUIStore } from '../store/uiStore'

function layoutModeIcon(mode: PanelLayoutMode) {
  switch (mode) {
    case 'classic':
      return <PanelBottom size={14} strokeWidth={1.5} />
    case 'sideTerminal':
      return <PanelLeft size={14} strokeWidth={1.5} />
    case 'sideDualEditor':
      return <Columns3 size={14} strokeWidth={1.5} />
  }
}

export default function TitleBar() {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [layoutMenu, setLayoutMenu] = useState<{ x: number; y: number } | null>(null)
  const panelLayout = useUIStore(s => s.panelLayout)
  const sideDualTerminal = useUIStore(s => s.sideDualTerminal)
  const sideEditorVisible = useUIStore(s => s.sideEditorVisible)
  const setPanelLayoutMode = useUIStore(s => s.setPanelLayoutMode)
  const layoutMode = resolvePanelLayoutMode(panelLayout, {
    dualTerminal: sideDualTerminal,
    editorVisible: sideEditorVisible,
  })
  const inTauri = isTauri()

  useEffect(() => {
    const onFocus = () => setWindowFocused(true)
    const onBlur = () => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    if (!inTauri) return
    const win = getCurrentWindow()
    let unlistenResize: (() => void) | undefined
    let unlistenClose: (() => void) | undefined

    win.isMaximized().then(setMaximized).catch(() => {})
    win.onResized(async () => {
      try {
        setMaximized(await win.isMaximized())
      } catch {}
    }).then(fn => {
      unlistenResize = fn
    }).catch(() => {})

    win.onCloseRequested(async event => {
      event.preventDefault()
      try {
        await requestAppClose()
      } catch (e) {
        useProjectStore.getState().pushToast('error', translate('关闭窗口失败: {error}', { error: String(e) }))
      }
    }).then(fn => {
      unlistenClose = fn
    }).catch(() => {})

    return () => {
      unlistenResize?.()
      unlistenClose?.()
    }
  }, [inTauri])

  const toggleMaximize = async () => {
    try {
      const win = getCurrentWindow()
      if (await win.isMaximized()) await win.unmaximize()
      else await win.maximize()
    } catch (e) {
      useProjectStore.getState().pushToast('error', translate('窗口最大化失败: {error}', { error: String(e) }))
    }
  }

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize()
    } catch (e) {
      useProjectStore.getState().pushToast('error', translate('窗口最小化失败: {error}', { error: String(e) }))
    }
  }

  const handleClose = async () => {
    try {
      await requestAppClose()
    } catch (e) {
      useProjectStore.getState().pushToast('error', translate('关闭窗口失败: {error}', { error: String(e) }))
    }
  }

  const openLayoutMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (layoutMenu) {
      setLayoutMenu(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setLayoutMenu({ x: Math.max(8, rect.right - 240), y: rect.bottom + 2 })
  }

  const layoutMenuItems: ContextMenuItem[] = PANEL_LAYOUT_MENU_MODES.map(mode => ({
    label: t(panelLayoutModeLabel(mode)),
    icon: layoutModeIcon(mode),
    checked: layoutMode === mode,
    action: () => setPanelLayoutMode(mode),
  }))

  return (
    <div
      className={`ui-font-scaled h-[var(--title-bar-height)] flex-shrink-0 flex items-center bg-bg border-b border-border select-none transition-opacity duration-150 ${
        windowFocused ? '' : 'opacity-60'
      }`}
      onDoubleClick={inTauri ? toggleMaximize : undefined}
    >
      <div className="flex-1 flex items-center h-full min-w-0">
        <div
          className="flex items-center h-full gap-0.5 px-3 flex-shrink-0"
          onDoubleClick={event => event.stopPropagation()}
        >
          <AppIcon size={14} className="flex-shrink-0" />
          <FileMenu onExit={handleClose} />
        </div>
        <ProjectPicker />
        <div
          className="flex-shrink-0 h-full w-[140px]"
          data-tauri-drag-region={inTauri ? true : undefined}
          onDoubleClick={inTauri ? event => {
            event.stopPropagation()
            void toggleMaximize()
          } : undefined}
        />
        <span
          className="flex h-full flex-shrink-0 items-center truncate px-3 text-[13px] font-semibold tracking-[0.01em] text-brand"
          data-tauri-drag-region={inTauri ? true : undefined}
          onDoubleClick={inTauri ? event => {
            event.stopPropagation()
            void toggleMaximize()
          } : undefined}
        >
          QingCode
        </span>
      </div>

      <div
        className="flex h-full flex-shrink-0 items-center"
        onDoubleClick={event => event.stopPropagation()}
      >
        <Tooltip label={t('选择面板布局')} side="bottom">
          <button
            type="button"
            aria-label={t('选择面板布局')}
            aria-haspopup="menu"
            aria-expanded={layoutMenu !== null}
            className={`w-[46px] h-full flex items-center justify-center transition-colors ${
              layoutMenu
                ? 'bg-bg-active text-fg'
                : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
            }`}
            onPointerDown={event => event.stopPropagation()}
            onClick={openLayoutMenu}
          >
            {layoutModeIcon(layoutMode)}
          </button>
        </Tooltip>
        {layoutMenu && (
          <ContextMenu
            x={layoutMenu.x}
            y={layoutMenu.y}
            preferAbove={false}
            items={layoutMenuItems}
            onClose={() => setLayoutMenu(null)}
          />
        )}
        {inTauri && (
          <>
            <WindowButton label={t('最小化')} onClick={handleMinimize}>
              <Minus size={14} strokeWidth={1.5} />
            </WindowButton>
            <WindowButton label={maximized ? t('还原') : t('最大化')} onClick={toggleMaximize}>
              {maximized ? (
                <Copy size={12} strokeWidth={1.5} />
              ) : (
                <Square size={12} strokeWidth={1.5} />
              )}
            </WindowButton>
            <WindowButton label={t('关闭窗口')} onClick={handleClose} danger>
              <X size={14} strokeWidth={1.5} />
            </WindowButton>
          </>
        )}
      </div>
    </div>
  )
}

function WindowButton({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  danger?: boolean
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        className={`w-[46px] h-full flex items-center justify-center text-fg-muted transition-colors
        ${danger ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-bg-hover hover:text-fg'}`}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}
