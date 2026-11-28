import { t, translateMessage } from '@qn/codex-client'
import { ChevronLeft, LoaderCircle, X, type LucideIcon, type LucideProps } from 'lucide-react'
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type TouchEvent } from 'react'
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
  icon,
  subtitle,
  onBack,
  right,
  className,
}: {
  title: string
  icon?: ReactNode
  subtitle?: ReactNode
  onBack?: () => void
  right?: ReactNode
  className?: string
}) {
  return (
    <header className={className ? `qn-header ${className}` : 'qn-header'}>
      {onBack && (
        <Button variant="ghost" className="qn-header-icon" onClick={onBack} aria-label={t('返回')}>
          <ChevronLeft size={22} strokeWidth={1.9} />
        </Button>
      )}
      {icon}
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
    <div className={`qn-note ${cls} mb-3 flex items-center gap-2`}>
      {/* 提示可能来自电脑端、daemon 或原生层，统一在展示时翻译；已是当前语言的原样返回。 */}
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{translateMessage(message)}</span>
      {actionLabel && onAction && (
        <button type="button" className="qn-note-action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {onClose && (
        <button type="button" className="qn-note-close" aria-label={t('关闭提示')} onClick={onClose}>
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
  closeAt = 'top',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  placement?: 'bottom' | 'left' | 'full'
  /** 关闭按钮放在标题栏；手机靠返回手势关闭，不再在底部放大号关闭按钮。内容自己处理关闭时（如看图点空白关闭）传 none。 */
  closeAt?: 'top' | 'none'
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

  // 底部弹层：内容滚到顶时向下拖动跟手，超过 80px 松手关闭，否则回弹。
  const drag = useRef<{ y: number; dy: number } | null>(null)
  const swipe = {
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
      drag.current = event.currentTarget.scrollTop <= 0 ? { y: event.touches[0]!.clientY, dy: 0 } : null
    },
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
      if (!drag.current) return
      drag.current.dy = Math.max(0, event.touches[0]!.clientY - drag.current.y)
      event.currentTarget.style.transition = 'none'
      event.currentTarget.style.transform = `translateY(${drag.current.dy}px)`
    },
    onTouchEnd: (event: TouchEvent<HTMLDivElement>) => {
      const dy = drag.current?.dy ?? 0
      drag.current = null
      const panel = event.currentTarget
      panel.style.transition = 'transform var(--qn-motion-medium) var(--qn-ease-sheet)'
      if (dy > 80) {
        panel.style.transform = 'translateY(100%)'
        window.setTimeout(() => close.current(), 180)
      } else {
        panel.style.transform = ''
      }
    },
  }

  return (
    <dialog ref={ref} className="qn-dialog" data-placement={placement} aria-label={title}
      // 嵌套弹层（如设置页里的选项面板）取消时只关自己，不冒泡到外层。
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}>
      <div className="qn-dialog-panel" {...(placement === 'bottom' ? swipe : {})}>
        <div className="mb-3 flex min-h-11 items-center gap-2">
          <h2 className="qn-title flex-1">{title}</h2>
          {closeAt === 'top' && (
            <Button autoFocus variant="ghost" className="qn-header-icon" onClick={onClose} aria-label={t('关闭')}>
              <X size={20} />
            </Button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  )
}

export function LoadingIcon({ className = '', ...props }: LucideProps) {
  return <LoaderCircle size={14} strokeWidth={2.5} aria-hidden="true" className={`qn-spin shrink-0 ${className}`} {...props} />
}

export function Loading({ text = t('正在加载…') }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-center text-sm text-qn-muted" role="status">
      <LoadingIcon size={16} />{text}
    </div>
  )
}

/** 会话所属 Agent 的小标签；用中性文字而非厂商 Logo（docs/agent-adapters.md §5）。 */
export function AgentTag({ agent }: { agent: AgentKind }) {
  const cls = agent === 'claude' ? 'qn-agent-tag-claude' : agent === 'pi' ? 'qn-agent-tag-pi' : ''
  return <span className={`qn-agent-tag ${cls}`}>{agentLabel(agent)}</span>
}

/** 底部弹层里的菜单行：圆形图标 + 文字，整行可点；需放在 .qn-sheet-actions 容器内。 */
export function SheetAction({ icon: Icon, children, onClick, danger = false, disabled }: {
  icon: LucideIcon; children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean
}) {
  return (
    <button type="button" className={`qn-sheet-action${danger ? ' qn-sheet-action-danger' : ''}`} disabled={disabled} onClick={onClick}>
      <span className="qn-sheet-action-label">{children}</span>
      <span className="qn-sheet-action-icon"><Icon size={18} strokeWidth={1.75} aria-hidden /></span>
    </button>
  )
}
