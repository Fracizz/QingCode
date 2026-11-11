import type { ProjectLabel } from '../lib/projectLabels'

/** Keep the project name readable; lists can move its source to a second line. */
export default function ProjectName({
  name,
  label,
  compact = false,
}: {
  name: string
  label?: ProjectLabel
  compact?: boolean
}) {
  if (!label?.source) {
    return (
      <span className={`block min-w-0 truncate ${compact ? 'max-w-[140px]' : ''}`}>{name}</span>
    )
  }
  return (
    <span className="project-name-label flex min-w-0 flex-1 items-center gap-1.5">
      <span
        className={`project-name-value block min-w-0 flex-1 truncate ${compact ? 'max-w-[140px]' : ''}`}
      >
        {name}
      </span>
      <ProjectSourceBadge source={label.source} />
    </span>
  )
}

/** 项目来源徽标（连接名 / 发行版 / 本机），项目卡片、进度卡和通知共用同一外观。 */
export function ProjectSourceBadge({ source, className = '' }: { source: string; className?: string }) {
  return (
    <span
      data-project-source
      className={`project-source-badge min-w-0 truncate rounded border border-border-strong/60 bg-fg/5 px-[5px] py-px font-normal text-fg-muted ${className}`}
    >
      {source}
    </span>
  )
}
