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
    <div className={`flex flex-col items-center justify-center gap-2.5 px-4 py-8 text-center modal-overlay-enter ${className}`}>
      {icon && (
        <div className="flex items-center justify-center p-3 rounded-full bg-bg-elevated/60 text-fg-dim border border-border/50 mb-1">
          {icon}
        </div>
      )}
      <p className="text-[13px] font-medium text-fg-muted">{title}</p>
      {hint && <p className="text-ui-sm text-fg-dim max-w-xs leading-relaxed">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
