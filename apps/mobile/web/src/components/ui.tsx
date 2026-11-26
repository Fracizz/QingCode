import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Tone = 'muted' | 'ok' | 'warn' | 'danger' | 'accent'

const toneClass: Record<Tone, string> = {
  muted: 'text-qn-muted',
  ok: 'text-qn-ok',
  warn: 'text-qn-warn',
  danger: 'text-qn-danger',
  accent: 'text-qn-accent',
}

export function StatusDot({ tone = 'muted' }: { tone?: Tone }) {
  const color =
    tone === 'ok'
      ? 'var(--color-qn-ok)'
      : tone === 'warn'
        ? 'var(--color-qn-warn)'
        : tone === 'danger'
          ? 'var(--color-qn-danger)'
          : tone === 'accent'
            ? 'var(--color-qn-accent)'
            : 'var(--color-qn-muted)'
  return <span className="qn-dot" style={{ background: color }} aria-hidden />
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`qn-badge ${toneClass[tone]}`}>{children}</span>
}

export function Button({
  variant = 'default',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  const variantClass =
    variant === 'primary'
      ? 'qn-button-primary'
      : variant === 'danger'
        ? 'qn-button-danger'
        : variant === 'ghost'
          ? 'qn-button-ghost'
          : ''
  return (
    <button type="button" className={`qn-button ${variantClass} ${className}`} {...rest}>
      {children}
    </button>
  )
}

export function Header({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  right?: ReactNode
}) {
  return (
    <header className="qn-header">
      {onBack && (
        <Button variant="ghost" className="px-2" onClick={onBack} aria-label="返回">
          ‹
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <div className="qn-title">{title}</div>
        {subtitle && <div className="qn-subtitle">{subtitle}</div>}
      </div>
      {right}
    </header>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`qn-card ${className}`}>{children}</div>
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="mb-3 block">
      <span className="qn-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-qn-muted">{hint}</span>}
    </label>
  )
}

export function Note({
  message,
  tone = 'muted',
  onClose,
  actionLabel,
  onAction,
}: {
  message: string
  tone?: Tone | 'error'
  onClose?: () => void
  actionLabel?: string
  onAction?: () => void
}) {
  const cls = tone === 'error' ? 'qn-note-error' : tone === 'warn' ? 'qn-note-warn' : ''
  return (
    <div className={`qn-note ${cls} mb-3 flex items-start gap-2`}>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      {actionLabel && onAction && (
        <button type="button" className="qn-button qn-button-ghost px-3 py-1 text-xs" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {onClose && (
        <button type="button" className="qn-button qn-button-ghost px-3 py-1 text-xs" onClick={onClose}>
          ✕
        </button>
      )}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-6 text-center text-sm text-qn-muted">
      <div>{children}</div>
    </div>
  )
}

export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="qn-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="qn-dialog-panel">
        <div className="mb-3 flex items-center gap-2">
          <span className="qn-title flex-1">{title}</span>
          <Button variant="ghost" className="px-2" onClick={onClose} aria-label="关闭">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Loading({ text = '正在加载…' }: { text?: string }) {
  return <div className="py-6 text-center text-sm text-qn-muted">{text}</div>
}
