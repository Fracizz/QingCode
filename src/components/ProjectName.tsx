import type { ProjectLabel } from '../lib/projectLabels'

/** Let the name shrink first; keep the source legible in narrow chips and list rows. */
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
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span
        className={`block min-w-0 truncate ${compact ? 'max-w-[140px]' : ''}`}
        style={{ flexShrink: 1000 }}
      >
        {name}
      </span>
      <span
        data-project-source
        className="min-w-0 max-w-[160px] truncate rounded border border-border-strong px-1 py-[3px] text-ui-badge font-normal text-fg-muted"
      >
        {label.source}
      </span>
    </span>
  )
}
