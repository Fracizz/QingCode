import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  AppWindow,
  Copy,
  Download,
  ExternalLink,
  Eye,
  LocateFixed,
  RotateCw,
} from 'lucide-react'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { isSshResource } from '../lib/tauri'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { copyPathAction } from '../lib/copyFileActions'
import { authorizePaths } from '../lib/pathAllowlist'
import { startSshTransfer } from '../lib/sshTransfer'
import {
  binaryFileTypeLabel,
  canPreviewAnyway,
  canRetryOpen,
  fileExtensionLabel,
  openFileErrorTitle,
} from '../lib/openFileError'
import { formatFileToastDetail } from '../utils/fileReferences'
import { baseName } from '../utils/fileTreeHelpers'
import type { EditorTab } from '../types'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

interface Props {
  tab: EditorTab
}

/** Join a local directory chosen in the dialog with a file name. */
function joinLocalPath(directory: string, name: string) {
  const separator = directory.includes('\\') || /^[A-Za-z]:/.test(directory) ? '\\' : '/'
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`
}

export default function EditorOpenError({ tab }: Props) {
  const { t } = useI18n()
  const retryOpenFile = useEditorStore(s => s.retryOpenFile)
  const previewAnywayFromError = useEditorStore(s => s.previewAnywayFromError)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const projects = useProjectStore(s => s.projects)
  const setView = useUIStore(s => s.setView)
  const [downloading, setDownloading] = useState(false)
  const kind = tab.openErrorKind ?? 'generic'
  const remote = isSshResource(tab.path)
  const title = t(openFileErrorTitle(kind, { remote }))
  const typeLabel = kind === 'binary' ? binaryFileTypeLabel(tab.path) : null
  const extLabel = kind === 'binary' ? fileExtensionLabel(tab.path) : ''
  // SSH URIs (`ssh://<connection-id>/…`) are noise; show the project-relative path.
  const displayPath = remote ? formatFileToastDetail(projects, tab.path) : tab.path

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

  /** Remote files have no local handler — fetch a copy first, then open it. */
  const downloadAndOpen = async () => {
    const destination = await openDialog({
      directory: true,
      multiple: false,
      title: t('选择下载目录'),
    })
    if (typeof destination !== 'string') return
    setDownloading(true)
    try {
      await authorizePaths([destination])
      const result = await startSshTransfer({
        direction: 'download',
        paths: [tab.path],
        destination,
        ephemeral: true,
      })
      if (result.status !== 'completed') {
        throw new Error(result.error ?? t('传输未完成'))
      }
      await openPath(joinLocalPath(destination, baseName(tab.path)))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('下载后打开失败：{error}', { error: String(error) }))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-8 py-10 text-center">
      <AlertTriangle size={48} strokeWidth={1.25} className="text-warn opacity-90" aria-hidden />
      <div className="max-w-xl space-y-2">
        <p className="text-ui-lg leading-relaxed text-fg">{title}</p>
        {kind === 'binary' ? (
          <p className="text-ui-sm leading-relaxed text-fg-muted">
            {typeLabel
              ? t('此文件是{type}（{ext}），不是文本文件。', { type: t(typeLabel), ext: extLabel })
              : t('此文件包含二进制内容，不是文本文件。')}
          </p>
        ) : tab.openError && tab.openError !== title ? (
          <p className="text-ui-sm leading-relaxed text-fg-muted">{tab.openError}</p>
        ) : null}
        {kind === 'binary' && remote ? (
          <p className="text-ui-sm leading-relaxed text-fg-muted">
            {t('需要查看内容时，可下载到本地后用对应应用打开。')}
          </p>
        ) : null}
        <Tooltip label={tab.path} side="bottom" onlyWhenOverflow wrapperClassName="block max-w-full">
          <p className="text-ui-sm truncate font-mono text-fg-dim">{displayPath}</p>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-ui">
        {canPreviewAnyway(kind) ? (
          <ActionButton
            icon={<Eye size={14} />}
            label={t('仍然打开（只读预览）')}
            onClick={() => void previewAnywayFromError(tab.id)}
          />
        ) : null}
        {remote ? (
          <ActionButton
            icon={<Download size={14} />}
            label={t('下载到本地并打开')}
            busy={downloading}
            onClick={() => void downloadAndOpen()}
          />
        ) : (
          <ActionButton
            icon={<AppWindow size={14} />}
            label={t('在关联的应用程序中打开')}
            onClick={() => void openWithAssociatedApp()}
          />
        )}
        {canRetryOpen(kind) ? (
          <ActionButton
            icon={<RotateCw size={14} />}
            label={t('重试')}
            onClick={() => void retryOpenFile(tab.id)}
          />
        ) : null}
        <ActionButton
          icon={<LocateFixed size={14} />}
          label={t('在资源管理器中定位')}
          onClick={revealInSidebar}
        />
        {!remote && (
          <ActionButton
            icon={<ExternalLink size={14} />}
            label={t('在文件管理器中显示')}
            onClick={() => void revealPath()}
          />
        )}
        <ActionButton
          icon={<Copy size={14} />}
          label={t('复制路径')}
          onClick={() => void copyPathAction(tab.path)}
        />
      </div>
    </div>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
  busy = false,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  busy?: boolean
}) {
  return (
    <button
      type="button"
      disabled={busy}
      className="inline-flex items-center gap-1.5 text-accent hover:underline focus:outline-none focus-visible:underline disabled:pointer-events-none disabled:opacity-60"
      onClick={onClick}
    >
      {busy ? <Download size={14} className="animate-pulse" /> : icon}
      {label}
    </button>
  )
}
