import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X, PanelBottom, PanelLeft } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { requestAppClose } from '../lib/appClose'
import { isTauri } from '../lib/tauri'
import { useProjectStore } from '../store/projectStore'
import AppIcon from './AppIcon'
import FileMenu from './FileMenu'
import Tooltip from './Tooltip'
import ProjectPicker from './ProjectPicker'
import { translate, useI18n } from '../lib/i18n'
import {
  cyclePanelLayoutTemplate,
  loadPanelLayoutTemplate,
  PANEL_LAYOUT_CHANGED_EVENT,
  type PanelLayoutTemplate,
} from '../lib/panelLayoutTemplate'

export default function TitleBar() {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [panelLayout, setPanelLayout] = useState<PanelLayoutTemplate>(() =>
    loadPanelLayoutTemplate(),
  )
  const inTauri = isTauri()

  useEffect(() => {
    const sync = () => setPanelLayout(loadPanelLayoutTemplate())
    window.addEventListener(PANEL_LAYOUT_CHANGED_EVENT, sync)
    return () => window.removeEventListener(PANEL_LAYOUT_CHANGED_EVENT, sync)
  }, [])

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
          className="px-3 text-[13px] text-fg-dim truncate flex-shrink-0 h-full flex items-center"
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
        <Tooltip
          label={
            panelLayout === 'classic'
              ? t('当前：经典布局（终端在底部）。点击切换为侧栏旁终端。')
              : t('当前：侧栏旁终端（侧栏 | 终端 | 编辑器）。点击切换为经典布局。')
          }
          side="bottom"
        >
          <button
            type="button"
            aria-label={t('切换面板布局')}
            className="w-[46px] h-full flex items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg transition-colors"
            onClick={() => cyclePanelLayoutTemplate()}
          >
            {panelLayout === 'classic' ? (
              <PanelBottom size={14} strokeWidth={1.5} />
            ) : (
              <PanelLeft size={14} strokeWidth={1.5} />
            )}
          </button>
        </Tooltip>
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
