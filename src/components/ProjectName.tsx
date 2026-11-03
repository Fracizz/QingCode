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
      <span
        data-project-source
        className="project-source-badge min-w-0 max-w-[45%] truncate rounded border border-border-strong/60 bg-fg/5 px-[5px] py-px font-normal text-fg-muted"
      >
        {label.source}
      </span>
    </span>
  )
}
