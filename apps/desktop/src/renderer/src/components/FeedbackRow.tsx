import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { CircleAlert, RotateCw, X } from 'lucide-react'
import { cn } from '../lib/cn'

function FeedbackAction({ className, ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-[1lh] min-w-5 shrink-0 items-center justify-center rounded-sm hover:bg-qn-hover focus-visible:outline-1 focus-visible:outline-current',
        className,
      )}
      {...props}
    />
  )
}

export function FeedbackRow({
  message,
  icon,
  actions,
  onClose,
  closeLabel = '关闭提示',
  role = 'status',
  className,
}: {
  message: string | null
  icon?: ReactNode
  actions?: ReactNode
  onClose?: () => void
  closeLabel?: string
  role?: 'alert' | 'status'
  className?: string
}) {
  if (!message) return null

  // 图标和按钮占一个正文行高，窄栏换行时仍与首行对齐。
  return (
    <div className={cn('flex min-w-0 items-start gap-2', className)}>
      {icon && (
        <span aria-hidden="true" className="inline-flex h-[1lh] shrink-0 items-center">
          {icon}
        </span>
      )}
      <span role={role} className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">{message}</span>
      {actions}
      {onClose && (
        <FeedbackAction onClick={onClose} aria-label={closeLabel}>
          <X size={14} aria-hidden="true" />
        </FeedbackAction>
      )}
    </div>
  )
}

const errorNoteVariants = {
  default: 'rounded-lg border border-qn-danger/30 px-3 py-2 text-[13px] leading-5',
  compact: 'rounded-lg px-2.5 py-1.5 text-[12px] leading-4',
  inline: 'shrink-0 border-b border-qn-border px-3 py-2 text-[12px] leading-5',
}

export function ErrorNote({
  message,
  onRetry,
  onClose,
  closeLabel,
  retryIcon,
  variant = 'default',
  className,
}: {
  message: string | null
  onRetry?: () => void
  onClose?: () => void
  closeLabel?: string
  retryIcon?: boolean
  variant?: keyof typeof errorNoteVariants
  className?: string
}) {
  return (
    <FeedbackRow
      message={message}
      role="alert"
      icon={variant !== 'compact' && <CircleAlert size={15} />}
      className={cn('bg-qn-danger/10 text-qn-danger', errorNoteVariants[variant], className)}
      actions={onRetry && (
        <FeedbackAction
          onClick={onRetry}
          aria-label="重试"
          className={retryIcon ? undefined : 'underline underline-offset-2'}
        >
          {retryIcon ? <RotateCw size={13} aria-hidden="true" /> : '重试'}
        </FeedbackAction>
      )}
      onClose={onClose}
      closeLabel={closeLabel}
    />
  )
}
