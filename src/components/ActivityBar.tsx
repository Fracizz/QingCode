import { FolderTree, Search, Terminal, Settings, FolderPlus, BugPlay, ListChecks, GitBranch } from 'lucide-react'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { useGitStatusStore } from '../store/gitStatusStore'

interface Props {
  active: 'explorer' | 'search' | 'sourceControl' | 'run' | 'settings'
  sidebarOpen: boolean
  onActiveChange: (v: 'explorer' | 'search' | 'sourceControl' | 'run' | 'settings') => void
  onToggleTerminal: () => void
  onAddProject: () => void
  onManageProjects: () => void
  terminalOpen: boolean
}

export default function ActivityBar({
  active,
  sidebarOpen,
  onActiveChange,
  onToggleTerminal,
  onAddProject,
  onManageProjects,
  terminalOpen,
}: Props) {
  const { t } = useI18n()
  const gitChanges = useGitStatusStore(s => s.dirtyCount)

  return (
    <div className="ui-font-scaled w-[var(--activity-bar-width)] flex-shrink-0 bg-bg-deep border-r border-border flex flex-col items-center py-2">
      <Item
        icon={<FolderTree size={22} />}
        label={t('资源管理器')}
        active={active === 'explorer' && sidebarOpen}
        onClick={() => onActiveChange('explorer')}
      />
      <Item
        icon={<Search size={22} />}
        label={t('搜索')}
        active={active === 'search' && sidebarOpen}
        onClick={() => onActiveChange('search')}
      />
      <Item
        icon={<GitBranch size={22} />}
        label={t('源代码管理')}
        active={active === 'sourceControl' && sidebarOpen}
        badge={gitChanges > 0 ? gitChanges : undefined}
        onClick={() => onActiveChange('sourceControl')}
      />
      <Item
        icon={<BugPlay size={22} />}
        label={t('运行配置')}
        active={active === 'run' && sidebarOpen}
        onClick={() => onActiveChange('run')}
      />
      <Item
        icon={<Settings size={22} />}
        label={t('设置')}
        active={active === 'settings' && sidebarOpen}
        onClick={() => onActiveChange('settings')}
      />

      <div className="w-6 h-px my-2 bg-border" aria-hidden="true" />

      <Item
        icon={<FolderPlus size={22} />}
        label={t('添加项目')}
        onClick={onAddProject}
      />
      <Item
        icon={<ListChecks size={22} />}
        label={t('项目管理')}
        onClick={onManageProjects}
      />
      <Item
        icon={<Terminal size={22} />}
        label={t('终端')}
        active={terminalOpen}
        onClick={onToggleTerminal}
      />
    </div>
  )
}

function Item({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  badge?: number
  onClick?: () => void
}) {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`relative w-10 h-10 flex items-center justify-center rounded-md mb-1 transition-colors
        ${active ? 'text-fg' : 'text-fg-muted hover:text-fg hover:bg-bg-hover'}`}
      >
        {active && (
          <span className="absolute left-[-8px] top-1 bottom-1 w-[2px] rounded bg-accent" />
        )}
        {icon}
        {badge !== undefined && (
          <span
            aria-hidden="true"
            className="absolute bottom-0.5 right-0.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-accent text-white text-[9px] font-semibold leading-[15px] text-center"
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
    </Tooltip>
  )
}
