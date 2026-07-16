import { ListTree, Search, Terminal, Settings, FolderPlus, BugPlay } from 'lucide-react'
import Tooltip from './Tooltip'

interface Props {
  active: 'explorer' | 'search' | 'run' | 'settings'
  onActiveChange: (v: 'explorer' | 'search' | 'run' | 'settings') => void
  onToggleTerminal: () => void
  onAddProject: () => void
  terminalOpen: boolean
}

export default function ActivityBar({
  active,
  onActiveChange,
  onToggleTerminal,
  onAddProject,
  terminalOpen,
}: Props) {
  return (
    <div className="ui-font-scaled w-[var(--activity-bar-width)] flex-shrink-0 bg-bg-deep border-r border-border flex flex-col items-center py-2">
      <Item
        icon={<ListTree size={22} />}
        label="资源管理器"
        active={active === 'explorer'}
        onClick={() => onActiveChange('explorer')}
      />
      <Item
        icon={<Search size={22} />}
        label="搜索"
        active={active === 'search'}
        onClick={() => onActiveChange('search')}
      />
      <Item
        icon={<BugPlay size={22} />}
        label="运行配置"
        active={active === 'run'}
        onClick={() => onActiveChange('run')}
      />
      <Item
        icon={<Settings size={22} />}
        label="设置"
        active={active === 'settings'}
        onClick={() => onActiveChange('settings')}
      />

      <div className="w-6 h-px my-2 bg-border" aria-hidden="true" />

      <Item
        icon={<FolderPlus size={22} />}
        label="添加项目"
        onClick={onAddProject}
      />
      <Item
        icon={<Terminal size={22} />}
        label="终端"
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
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
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
      </button>
    </Tooltip>
  )
}
