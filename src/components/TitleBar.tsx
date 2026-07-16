import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '../lib/tauri'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import AppIcon from './AppIcon'
import Tooltip from './Tooltip'
import ProjectPicker from './ProjectPicker'
import { confirmDialog } from '../store/confirmStore'
import { useTerminalStore } from '../store/terminalStore'
import { confirmDiscardTabs } from '../utils/dirtyTabs'

async function requestAppClose() {
  const runningTerminals = useTerminalStore
    .getState()
    .terminals.filter(terminal => terminal.status !== 'exited')
  const detail =
    runningTerminals.length > 0
      ? `${runningTerminals.length} 个终端仍在运行，退出后将终止。\n未保存的编辑器更改可能丢失。`
      : '未保存的编辑器更改可能丢失。'

  if (
    !(await confirmDialog({
      title: '退出 QingCode',
      message: '确定要关闭应用程序吗？',
      detail,
      kind: 'warning',
      confirmLabel: '退出',
      cancelLabel: '取消',
    }))
  ) {
    return
  }
  if (!(await confirmDiscardTabs(useEditorStore.getState().tabs, '退出应用'))) return
  await getCurrentWindow().destroy()
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const inTauri = isTauri()

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
        useProjectStore.getState().pushToast('error', `关闭窗口失败: ${String(e)}`)
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
      await requestAppClose()
    } catch (e) {
      useProjectStore.getState().pushToast('error', `关闭窗口失败: ${String(e)}`)
    }
  }

  return (
    <div className="ui-font-scaled h-[var(--title-bar-height)] flex-shrink-0 flex items-center bg-bg border-b border-border select-none">
      <div className="flex-1 flex items-center h-full min-w-0">
        <div className="flex items-center h-full px-3 flex-shrink-0">
          <AppIcon size={14} className="flex-shrink-0" />
        </div>
        <ProjectPicker />
        <div
          className="flex-shrink-0 h-full w-[140px]"
          data-tauri-drag-region={inTauri ? true : undefined}
          onDoubleClick={inTauri ? toggleMaximize : undefined}
        />
        <span className="px-3 text-[12px] text-fg-dim truncate flex-shrink-0">QingCode</span>
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
