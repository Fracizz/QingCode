import { Cloud, Folder, FolderOpen, Monitor } from 'lucide-react'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { isSshProject } from '../lib/sshWorkspace'
import { isWslProject } from '../lib/wslWorkspace'
import type { Project, SshConnection } from '../types'

export function ProjectKindIcon({
  project,
  connections,
  size = 13,
  className,
  open = false,
}: {
  project: Pick<Project, 'kind' | 'path'> & Partial<Pick<Project, 'connection_id'>>
  connections?: ReadonlyArray<Pick<SshConnection, 'id' | 'name'>>
  size?: number
  className?: string
  open?: boolean
}) {
  if (isWslProject(project, connections)) {
    return <Cloud size={size} className={className} />
  }
  if (isSshProject(project)) {
    return <Monitor size={size} className={className} />
  }
  const Icon = open ? FolderOpen : Folder
  return <Icon size={size} className={className} />
}

export function WslKindBadge({ label = 'WSL' }: { label?: string } = {}) {
  const { t } = useI18n()
  return (
    <Tooltip label={t('WSL 项目')} side="bottom" wrapperClassName="inline-flex flex-shrink-0">
      <span className="inline-flex items-center rounded border border-border-strong px-1 py-px text-ui-2xs leading-none text-fg-muted">
        {label}
      </span>
    </Tooltip>
  )
}

export function SshKindBadge() {
  const { t } = useI18n()
  return (
    <Tooltip label={t('SSH 远程项目')} side="bottom" wrapperClassName="inline-flex flex-shrink-0">
      <span className="inline-flex items-center rounded border border-border-strong px-1 py-px text-ui-2xs leading-none text-fg-muted">
        {t('SSH')}
      </span>
    </Tooltip>
  )
}

export function ProjectKindBadge({
  project,
  connections,
}: {
  project: Pick<Project, 'kind' | 'path'> & Partial<Pick<Project, 'connection_id'>>
  connections?: ReadonlyArray<Pick<SshConnection, 'id' | 'name'>>
}) {
  if (isWslProject(project, connections)) {
    return <WslKindBadge />
  }
  if (isSshProject(project)) {
    return <SshKindBadge />
  }
  return null
}


