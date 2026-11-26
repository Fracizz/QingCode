import { ChevronLeft, X } from 'lucide-react'
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { agentLabel } from '../agents'
import type { AgentKind } from '../types'
import { registerBackHandler } from '../workspace'

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
        <Button variant="ghost" className="qn-header-icon" onClick={onBack} aria-label="返回">
          <ChevronLeft size={22} strokeWidth={1.9} />
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
        <button type="button" className="qn-button qn-button-ghost px-3 py-1 text-xs" aria-label="关闭提示" onClick={onClose}>
          <X size={15} />
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
  placement = 'bottom',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  placement?: 'bottom' | 'side' | 'full'
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.showModal()
    const unregister = registerBackHandler(() => close.current())
    return () => {
      unregister()
      node.close()
    }
  }, [])

  return (
    <dialog ref={ref} className="qn-dialog" data-placement={placement} aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
      <div className="qn-dialog-panel">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="qn-title flex-1">{title}</h2>
          <Button autoFocus variant="ghost" className="qn-header-icon" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

export function Loading({ text = '正在加载…' }: { text?: string }) {
  return <div className="py-6 text-center text-sm text-qn-muted">{text}</div>
}

/** 会话所属 Agent 的小标签；用中性文字而非厂商 Logo（docs/agent-adapters.md §5）。 */
export function AgentTag({ agent }: { agent: AgentKind }) {
  const cls = agent === 'claude' ? 'qn-agent-tag-claude' : agent === 'pi' ? 'qn-agent-tag-pi' : ''
  return <span className={`qn-agent-tag ${cls}`}>{agentLabel(agent)}</span>
}
