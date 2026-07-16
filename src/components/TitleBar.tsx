import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '../lib/tauri'
import { useProjectStore } from '../store/projectStore'
import AppIcon from './AppIcon'
import Tooltip from './Tooltip'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const inTauri = isTauri()
  const currentProject = useProjectStore(s => s.currentProject)

  useEffect(() => {
    if (!inTauri) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined

    win.isMaximized().then(setMaximized).catch(() => {})
    win.onResized(async () => {
      try {
        setMaximized(await win.isMaximized())
      } catch {}
    }).then(fn => {
      unlisten = fn
    }).catch(() => {})

    return () => unlisten?.()
  }, [inTauri])

  const toggleMaximize = async () => {
    try {
      const win = getCurrentWindow()
      if (await win.isMaximized()) await win.unmaximize()
      else await win.maximize()
    } catch (e) {
      useProjectStore.getState().pushToast('error', `窗口最大化失败: ${String(e)}`)
    }
  }

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize()
    } catch (e) {
      useProjectStore.getState().pushToast('error', `窗口最小化失败: ${String(e)}`)
    }
  }

  const handleClose = async () => {
    try {
      await getCurrentWindow().close()
    } catch (e) {
      useProjectStore.getState().pushToast('error', `关闭窗口失败: ${String(e)}`)
    }
  }

  return (
    <div className="ui-font-scaled h-[var(--title-bar-height)] flex-shrink-0 flex items-center bg-bg border-b border-border select-none">
      <div
        className="flex-1 flex items-center h-full px-3 gap-2 min-w-0"
        data-tauri-drag-region={inTauri ? true : undefined}
        onDoubleClick={inTauri ? toggleMaximize : undefined}
      >
        <AppIcon size={14} className="flex-shrink-0" />
        <span className="text-[12px] text-fg-muted truncate">
          {currentProject ? `${currentProject.name} — QingCode` : 'QingCode'}
        </span>
      </div>

      {inTauri && (
        <div className="flex h-full flex-shrink-0">
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
