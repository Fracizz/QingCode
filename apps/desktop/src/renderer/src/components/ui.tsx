import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { Checkbox as RadixCheckbox, Dialog } from 'radix-ui'
import { cn } from '../lib/cn'
import { DialogFrame } from './DialogFrame'
import { LoadingIcon } from './LoadingIcon'
import { Tip } from './primitives'

export { ErrorNote } from './FeedbackRow'

export function IconButton({
  label,
  children,
  danger,
  tooltip = true,
  size = 'md',
  className,
  ref,
  ...props
}: ComponentPropsWithRef<'button'> & {
  label: string
  danger?: boolean
  tooltip?: boolean
  /** md：32px 方钮（工具栏、标题栏）；sm：24px（面板头、行内操作）。 */
  size?: 'sm' | 'md'
}) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent disabled:opacity-40',
        size === 'sm' ? 'h-6 w-6 rounded-md' : 'h-8 w-8 rounded-lg',
        danger && 'hover:text-qn-danger',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
  return tooltip ? <Tip label={label}>{button}</Tip> : button
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-1.5 text-[13px] text-qn-muted">
      <LoadingIcon />
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
    muted: 'bg-white/[0.06] text-qn-muted',
    accent: 'bg-qn-accent/12 text-qn-accent',
    danger: 'bg-qn-danger/12 text-qn-danger',
    warn: 'bg-qn-warn/12 text-qn-warn',
    ok: 'bg-qn-ok/12 text-qn-ok',
  }
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-md px-1.5 text-[11px] leading-5', tones[tone] ?? tones.muted)}>
      {children}
    </span>
  )
}

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-3 py-6 text-center text-[13px] leading-6 text-qn-muted', className)}>{children}</div>
}

/**
 * 对话框（Radix Dialog）：焦点锁定在框内、Esc/点遮罩关闭、关闭后焦点回到触发处。
 * 高度封顶在 680px / 视口减 80px，超出部分只滚动正文，标题与底部操作始终可见。
 */
export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  width = 'max-w-lg',
  bodyClassName,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose?: () => void
  width?: string
  bodyClassName?: string
}) {
  return (
    <DialogFrame
      described={Boolean(description)}
      onClose={onClose}
      overlayClassName="qn-overlay grid place-items-center p-6"
      className={cn('qn-dialog max-h-[min(680px,calc(100vh-80px))] w-full', width)}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-4">
        <div className="min-w-0">
          <Dialog.Title className="text-[15px] font-semibold text-qn-text">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-1 text-[13px] text-qn-muted">{description}</Dialog.Description>
          )}
        </div>
        {onClose && (
          <Dialog.Close asChild>
            <IconButton label="关闭" tooltip={false} className="-mr-2 -mt-1">
              <X size={16} />
            </IconButton>
          </Dialog.Close>
        )}
      </div>
      <div className={cn('qn-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-2 text-[13px]', bodyClassName)}>
        {children}
      </div>
      {footer && <div className="shrink-0 border-t border-qn-border px-5 py-3">{footer}</div>}
    </DialogFrame>
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
  // Radix Checkbox：原生复选框在暗色主题下是系统样式，和其它控件对不齐。
  return (
    <label className={cn('flex items-center gap-2 text-[13px] text-qn-text', disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer')}>
      <RadixCheckbox.Root
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-qn-border-strong bg-[#161616] text-white outline-none focus-visible:ring-1 focus-visible:ring-qn-accent data-[state=checked]:border-qn-accent data-[state=checked]:bg-qn-accent"
      >
        <RadixCheckbox.Indicator>
          <Check size={12} strokeWidth={3} />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      <span>{children}</span>
    </label>
  )
}
