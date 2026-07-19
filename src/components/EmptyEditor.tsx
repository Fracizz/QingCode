import { Clock, FileText, FolderOpen, Settings, Terminal as TerminalIcon } from 'lucide-react'
import AppIcon from './AppIcon'
import Kbd from './Kbd'
import Tooltip from './Tooltip'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'

/** Lightweight empty editor so CodeMirror is not downloaded until a file is opened. */
export default function EmptyEditor() {
  const { t } = useI18n()
  const recentFiles = useProjectStore(s => s.recentFiles)
  const projects = useProjectStore(s => s.projects)
  const switchProject = useProjectStore(s => s.switchProject)
  const addProjectFromDialog = useProjectStore(s => s.addProjectFromDialog)
  const openFile = useEditorStore(s => s.openFile)
  const setView = useUIStore(s => s.setView)
  const openTerminalPanel = useUIStore(s => s.openTerminalPanel)
  const recent = recentFiles.slice(0, 8)
  const recentProjects = projects.filter(p => !p.hidden).slice(0, 5)

  const actions = [
    {
      icon: <FolderOpen size={14} />,
      label: t('打开项目'),
      onClick: () => void addProjectFromDialog(),
    },
    {
      icon: <TerminalIcon size={14} />,
      label: t('打开终端面板'),
      onClick: openTerminalPanel,
    },
    {
      icon: <Settings size={14} />,
      label: t('打开设置'),
      onClick: () => setView('settings'),
    },
  ]

  return (
    <div className="ui-font-scaled flex-1 flex flex-col items-center justify-center text-fg-dim bg-bg gap-6 px-6 select-none">
      {/* Decorative background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-accent/[0.03] blur-3xl" />
      </div>

      <div className="flex flex-col items-center gap-3 relative">
        <div className="relative">
          <div className="absolute inset-0 bg-accent/10 blur-xl rounded-full scale-150" aria-hidden="true" />
          <AppIcon size={52} />
        </div>
        <p className="text-sm text-fg-muted">{t('从侧边栏打开文件开始编辑')}</p>
      </div>

      <div className="flex items-center gap-2 relative">
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1.5 rounded-md border border-border-strong bg-bg-elevated/80 px-3.5 py-2 text-[13px] text-fg-muted transition-all duration-150 hover:bg-bg-active hover:text-fg hover:shadow-sm hover:-translate-y-[1px] active:translate-y-0"
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>

      {recentProjects.length > 0 && (
        <div className="flex flex-col items-center gap-2 relative">
          <p className="text-[11px] font-semibold tracking-wide text-fg-dim uppercase">{t('最近项目')}</p>
          <div className="flex flex-wrap items-center justify-center gap-1.5 max-w-[420px]">
            {recentProjects.map(project => (
              <Tooltip
                key={project.id}
                label={project.path}
                side="bottom"
                wrapperClassName="max-w-[180px]"
              >
                <button
                  type="button"
                  onClick={() => void switchProject(project)}
                  className="max-w-[180px] truncate rounded-full border border-border px-3 py-1 text-[12px] text-fg-muted transition-all duration-150 hover:border-border-strong hover:bg-bg-hover hover:text-fg hover:shadow-sm"
                >
                  {project.name}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-fg-dim/70 flex items-center gap-1.5 relative">
        <Kbd>Ctrl+Shift+C</Kbd> {t('路径')} <span className="text-fg-dim/40">·</span> <Kbd>Alt+C</Kbd> {t('文件引用')}
      </p>
      {recent.length > 0 && (
        <div className="mt-2 w-full max-w-md">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            <Clock size={12} />
            {t('最近打开的文件')}
          </div>
          <ul className="space-y-0.5">
            {recent.map(file => (
              <li key={file.path}>
                <Tooltip label={file.path} side="bottom" wrapperClassName="block w-full">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-fg-muted hover:bg-bg-hover hover:text-fg transition-colors"
                    onClick={() => void openFile(file.path)}
                  >
                    <FileText size={12} className="flex-shrink-0 opacity-70" />
                    <span className="truncate font-medium text-fg">
                      {file.path.split(/[/\\]/).pop() || file.path}
                    </span>
                    <span className="ml-auto truncate text-[11px] text-fg-dim max-w-[55%]">
                      {file.path}
                    </span>
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
