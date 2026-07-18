import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { requestAppClose } from '../lib/appClose'
import { isTauri } from '../lib/tauri'
import { useProjectStore } from '../store/projectStore'
import AppIcon from './AppIcon'
import FileMenu from './FileMenu'
import Tooltip from './Tooltip'
import ProjectPicker from './ProjectPicker'
import { translate } from '../lib/i18n'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
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
          className="px-3 text-[12px] text-fg-dim truncate flex-shrink-0 h-full flex items-center"
          data-tauri-drag-region={inTauri ? true : undefined}
          onDoubleClick={inTauri ? event => {
            event.stopPropagation()
            void toggleMaximize()
          } : undefined}
        >
          QingCode
        </span>
      </div>

      {inTauri && (
        <div
          className="flex h-full flex-shrink-0"
          onDoubleClick={event => event.stopPropagation()}
        >
          <WindowButton label="Minimize" onClick={handleMinimize}>
            <Minus size={14} strokeWidth={1.5} />
          </WindowButton>
          <WindowButton label={maximized ? 'Restore' : 'Maximize'} onClick={toggleMaximize}>
            {maximized ? (
              <Copy size={12} strokeWidth={1.5} />
            ) : (
              <Square size={12} strokeWidth={1.5} />
            )}
          </WindowButton>
          <WindowButton label="Close" onClick={handleClose} danger>
            <X size={14} strokeWidth={1.5} />
          </WindowButton>
        </div>
      )}
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
