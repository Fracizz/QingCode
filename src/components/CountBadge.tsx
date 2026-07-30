export type CountBadgeSize = 'scm' | 'chip'

function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function sizeClass(size: CountBadgeSize, count: number): string {
  if (size === 'scm') return 'h-4 min-w-4 px-1 text-[9px]'
  const label = badgeLabel(count)
  if (label.length === 1) return 'size-3.5 px-0 text-[9px]'
  if (label.length === 2) return 'h-3.5 min-w-3.5 px-0.5 text-[9px]'
  return 'h-3.5 min-w-[1.375rem] px-0.5 text-[9px]'
}

function toneClass(size: CountBadgeSize, count: number): string {
  if (count <= 0) return 'border border-border bg-bg-elevated text-fg-dim'
  if (size === 'chip') {
    return 'bg-accent/12 text-accent/85 transition-colors group-hover:bg-accent/20 group-hover:text-accent hover:bg-accent/20 hover:text-accent'
  }
  return 'bg-accent text-white'
}

export function CountBadge({
  count,
  size = 'scm',
  className = '',
}: {
  count: number
  size?: CountBadgeSize
  className?: string
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold leading-none tabular-nums ${sizeClass(size, count)} ${toneClass(size, count)} ${className}`}
    >
      {badgeLabel(count)}
    </span>
  )
}
