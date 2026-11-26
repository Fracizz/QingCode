import { CircleAlert, LoaderCircle, X } from 'lucide-react'
import type { ReactNode } from 'react'

export function IconButton({
  label,
  onClick,
  children,
  disabled,
  danger,
  className = '',
}: {
  label: string
  onClick?: () => void
  children: ReactNode
  disabled?: boolean
  danger?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-qn-muted hover:bg-white/10 hover:text-white disabled:opacity-40 ${
        danger ? 'hover:text-qn-danger' : ''
      } ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-qn-muted">
      <LoaderCircle size={13} className="animate-spin" />
      {label}
    </span>
  )
}

export function Badge({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'muted' | 'accent' | 'danger' | 'warn' | 'ok'
}) {
  const tones: Record<string, string> = {
    muted: 'border-qn-border text-qn-muted',
    accent: 'border-qn-accent/50 text-qn-accent',
    danger: 'border-qn-danger/50 text-qn-danger',
    warn: 'border-amber-400/50 text-amber-300',
    ok: 'border-emerald-400/50 text-emerald-300',
  }
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] leading-4 ${tones[tone] ?? tones.muted}`}>
      {children}
    </span>
  )
}

export function ErrorNote({
  message,
  onRetry,
  onClose,
}: {
  message: string | null
  onRetry?: () => void
  onClose?: () => void
}) {
  if (!message) return null
  return (
    <div className="flex items-start gap-2 rounded border border-qn-danger/40 bg-qn-danger/10 px-3 py-2 text-xs text-qn-danger">
      <CircleAlert size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      {onRetry && (
        <button type="button" className="shrink-0 underline" onClick={onRetry}>
          重试
        </button>
      )}
      {onClose && (
        <button type="button" className="shrink-0" onClick={onClose} aria-label="关闭提示">
          <X size={12} />
        </button>
      )}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-xs leading-6 text-qn-muted">{children}</div>
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 'max-w-lg',
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose?: () => void
  width?: string
}) {
  return (
    <div
      className="qn-no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[86vh] w-full ${width} flex-col overflow-hidden rounded-lg border border-qn-border bg-qn-panel shadow-2xl`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-qn-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {onClose && <IconButton label="关闭" onClick={onClose}><X size={15} /></IconButton>}
        </div>
        <div className="qn-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-qn-border px-4 py-3">{footer}</div>
        )}
      </div>
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-qn-muted">
      <input
        type="checkbox"
        className="accent-qn-accent"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  )
}
