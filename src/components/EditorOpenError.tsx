import type { ReactNode } from 'react'
import { AlertTriangle, AppWindow, Copy, ExternalLink, LocateFixed, RotateCw } from 'lucide-react'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { copyToClipboard } from '../utils/fileReferences'
import { openFileErrorTitle } from '../lib/openFileError'
import type { EditorTab } from '../types'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

interface Props {
  tab: EditorTab
}

export default function EditorOpenError({ tab }: Props) {
  const { t } = useI18n()
  const retryOpenFile = useEditorStore(s => s.retryOpenFile)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const setView = useUIStore(s => s.setView)
  const kind = tab.openErrorKind ?? 'generic'
  const title = t(openFileErrorTitle(kind))

  const copyPath = async () => {
    try {
      await copyToClipboard(tab.path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
    }
  }

  const revealInSidebar = () => {
    setView('explorer')
    void revealFileInTree(tab.path, { force: true })
  }

  const revealPath = async () => {
    try {
      await revealItemInDir(tab.path)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('在文件管理器中显示失败: {error}', { error: String(error) }))
    }
  }

  const openWithAssociatedApp = async () => {
    try {
      await openPath(tab.path)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('在关联的应用程序中打开失败: {error}', { error: String(error) }))
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-8 py-10 text-center">
      <AlertTriangle size={48} strokeWidth={1.25} className="text-warn opacity-90" aria-hidden />
      <div className="max-w-xl space-y-2">
        <p className="text-sm leading-relaxed text-fg">{title}</p>
        {tab.openError && tab.openError !== title ? (
          <p className="text-ui-sm leading-relaxed text-fg-muted">{tab.openError}</p>
        ) : null}
        <Tooltip label={tab.path} side="bottom" onlyWhenOverflow wrapperClassName="block max-w-full">
          <p className="text-ui-sm truncate font-mono text-fg-dim">{tab.path}</p>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px]">
        <ActionButton
          icon={<AppWindow size={14} />}
          label={t('在关联的应用程序中打开')}
          onClick={() => void openWithAssociatedApp()}
        />
        <ActionButton
          icon={<RotateCw size={14} />}
          label={t('重试')}
          onClick={() => void retryOpenFile(tab.id)}
        />
        <ActionButton
          icon={<LocateFixed size={14} />}
          label={t('在资源管理器中定位')}
          onClick={revealInSidebar}
        />
        <ActionButton
          icon={<ExternalLink size={14} />}
          label={t('在文件管理器中显示')}
          onClick={() => void revealPath()}
        />
        <ActionButton
          icon={<Copy size={14} />}
          label={t('复制路径')}
          onClick={() => void copyPath()}
        />
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-accent hover:underline focus:outline-none focus-visible:underline"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}
