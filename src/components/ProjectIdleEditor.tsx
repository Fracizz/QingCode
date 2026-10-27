import type { LucideIcon } from 'lucide-react'
import { FilePlus, FileText, Search, Terminal as TerminalIcon, Zap } from 'lucide-react'
import Kbd from './Kbd'
import Tooltip from './Tooltip'
import ProjectName from './ProjectName'
import { useI18n } from '../lib/i18n'
import { recentFileParentLabel } from '../lib/editorSurface'
import { sshFileDisplayPath } from '../lib/sshWorkspace'
import { getFileIcon } from '../utils/fileIcons'
import { useProjectLabels } from '../hooks/useProjectLabels'
import { useCommandPaletteStore } from '../store/commandPaletteStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useShortcutStore } from '../store/shortcutStore'
import { useUIStore } from '../store/uiStore'

const MAX_RECENT = 6

/**
 * 项目内关闭全部标签后的轻量空态：只给“继续打开文件”相关的操作与本项目最近文件，
 * 不再弹出带 Logo 的完整欢迎页。
 */
export default function ProjectIdleEditor() {
  const { t } = useI18n()
  const projectLabels = useProjectLabels()
  const currentProject = useProjectStore(s => s.currentProject)
  const recentFiles = useProjectStore(s => s.recentFiles)
  const sshConnections = useProjectStore(s => s.sshConnections)
  const openFile = useEditorStore(s => s.openFile)
  const openPalette = useCommandPaletteStore(s => s.openPalette)
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const requestNewFile = useUIStore(s => s.requestNewFile)
  const requestGlobalSearch = useUIStore(s => s.requestGlobalSearch)
  const requestToggleTerminal = useUIStore(s => s.requestToggleTerminal)

  if (!currentProject) return <div className="min-h-0 flex-1 bg-bg" />

  const recent = recentFiles
    .filter(file => file.project_id === currentProject.id)
    .slice(0, MAX_RECENT)

  const actions: Array<{ icon: LucideIcon; label: string; shortcut?: string; onClick: () => void }> = [
    { icon: Zap, label: t('快速打开文件'), shortcut: shortcuts.quickOpen, onClick: () => openPalette('') },
    { icon: FilePlus, label: t('新建文件'), onClick: requestNewFile },
    { icon: Search, label: t('打开搜索'), shortcut: shortcuts.searchAllProjects, onClick: () => requestGlobalSearch() },
    { icon: TerminalIcon, label: t('切换终端'), shortcut: shortcuts.toggleTerminal, onClick: requestToggleTerminal },
  ]

  return (
    <div
      className="project-idle-editor ui-font-scaled min-h-0 flex-1 flex flex-col items-center overflow-auto bg-bg px-6 py-6 text-fg-dim select-none"
      data-testid="project-idle-editor"
    >
      {/* 上下留白比例 2:3，视觉重心略偏上 */}
      <div className="flex-[2]" aria-hidden />
      <div className="flex w-full max-w-sm shrink-0 flex-col gap-5">
        <div className="truncate text-center text-ui-lg text-fg-muted">
          <ProjectName name={currentProject.name} label={projectLabels.get(currentProject.id)} />
        </div>

        <ul className="flex flex-col gap-0.5">
          {actions.map(action => {
            const Icon = action.icon
            return (
              <li key={action.label}>
                <button
                  type="button"
                  onClick={action.onClick}
                  className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-ui-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
                >
                  <Icon size={13} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.shortcut && <Kbd>{action.shortcut}</Kbd>}
                </button>
              </li>
            )
          })}
        </ul>

        {recent.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="px-2.5 text-ui-xs font-semibold uppercase tracking-wide text-fg-dim">
              {t('最近打开的文件')}
            </p>
            <ul className="flex flex-col gap-0.5">
              {recent.map(file => {
                const name = file.path.split(/[/\\]/).pop() || file.path
                const Icon = getFileIcon(name) ?? FileText
                const parent = recentFileParentLabel(currentProject.path, file.path)
                const tooltipPath = file.path.startsWith('ssh://')
                  ? sshFileDisplayPath(file.path, sshConnections)
                  : file.path
                return (
                  <li key={file.path}>
                    <Tooltip label={tooltipPath} side="bottom" wrapperClassName="block w-full">
                      <button
                        type="button"
                        onClick={() => void openFile(file.path)}
                        className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-ui-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
                      >
                        <Icon size={13} className="shrink-0 opacity-70" />
                        <span className="truncate text-fg">{name}</span>
                        {parent && (
                          <span className="ml-auto max-w-[55%] truncate text-fg-dim">{parent}</span>
                        )}
                      </button>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
      <div className="flex-[3]" aria-hidden />
    </div>
  )
}
