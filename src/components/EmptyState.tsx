import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  hint?: string
  /** Optional call-to-action rendered below the text (e.g. a button). */
  action?: ReactNode
  className?: string
}

/** Unified empty/placeholder state: centered icon + title + optional hint and CTA. */
export default function EmptyState({ icon, title, hint, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-4 py-8 text-center ${className}`}>
      {icon && <div className="text-fg-dim">{icon}</div>}
      <p className="text-[13px] text-fg-muted">{title}</p>
      {hint && <p className="text-[12px] text-fg-dim">{hint}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}
