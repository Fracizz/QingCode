import { Cloud, Folder, FolderClosed, FolderOpen } from 'lucide-react'
import Tooltip from './Tooltip'
import { ProjectSourceBadge } from './ProjectName'
import { useI18n } from '../lib/i18n'
import { isSshProject } from '../lib/sshWorkspace'
import { isWslProject } from '../lib/wslWorkspace'
import type { Project } from '../types'
import SshPreparationIcon from './SshPreparationIcon'

export function ProjectKindIcon({
  project,
  size = 14,
  className,
  open = false,
  closed = false,
  preparation = false,
  strokeWidth,
  absoluteStrokeWidth,
}: {
  project: Pick<Project, 'kind' | 'path'>
  size?: number
  className?: string
  open?: boolean
  /** 本地项目用带横线的闭合文件夹（终端列表组头），优先于 open。 */
  closed?: boolean
  preparation?: boolean
  /** 透传给 lucide；配合 absoluteStrokeWidth 可在不同尺寸下保持同一绝对线宽。 */
  strokeWidth?: number
  absoluteStrokeWidth?: boolean
}) {
  const stroke = { strokeWidth, absoluteStrokeWidth }
  if (preparation && isSshProject(project)) {
    return <SshPreparationIcon path={project.path} size={size} className={className} />
  }
  if (isWslProject(project) || isSshProject(project)) {
    return <Cloud size={size} className={className} {...stroke} />
  }
  const Icon = closed ? FolderClosed : open ? FolderOpen : Folder
  return <Icon size={size} className={className} {...stroke} />
}

/** 项目类型徽标与来源徽标（连接名 / 发行版）同一外观，并排时高度、字号一致。 */
export function WslKindBadge({ label = 'WSL' }: { label?: string } = {}) {
  const { t } = useI18n()
  return (
    <Tooltip label={t('WSL 项目')} side="bottom" wrapperClassName="inline-flex flex-shrink-0">
      <ProjectSourceBadge source={label} className="flex-shrink-0" />
    </Tooltip>
  )
}

export function SshKindBadge() {
  const { t } = useI18n()
  return (
    <Tooltip label={t('SSH 远程项目')} side="bottom" wrapperClassName="inline-flex flex-shrink-0">
      <ProjectSourceBadge source={t('SSH')} className="flex-shrink-0" />
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
