import { Cloud, Folder, FolderOpen } from 'lucide-react'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { isSshProject } from '../lib/sshWorkspace'
import { isWslProject } from '../lib/wslWorkspace'
import type { Project } from '../types'

export function ProjectKindIcon({
  project,
  size = 13,
  className,
  open = false,
}: {
  project: Pick<Project, 'kind' | 'path'>
  size?: number
  className?: string
  open?: boolean
}) {
  if (isWslProject(project) || isSshProject(project)) {
    return <Cloud size={size} className={className} />
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
}: {
  project: Pick<Project, 'kind' | 'path'>
}) {
  if (isWslProject(project)) return <WslKindBadge />
  if (isSshProject(project)) return <SshKindBadge />
  return null
}
