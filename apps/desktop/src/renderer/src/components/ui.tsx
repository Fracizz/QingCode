import type { ComponentPropsWithRef, ReactNode } from 'react'
import { CircleAlert, LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { cn } from '../lib/cn'
import { Tip } from './primitives'

export function IconButton({
  label,
  children,
  danger,
  tooltip = true,
  className,
  ref,
  ...props
}: ComponentPropsWithRef<'button'> & { label: string; danger?: boolean; tooltip?: boolean }) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-qn-muted outline-none hover:bg-qn-hover hover:text-qn-text focus-visible:ring-1 focus-visible:ring-qn-accent disabled:opacity-40',
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
    <span className="inline-flex items-center gap-1.5 text-[13px] text-qn-muted">
      <LoaderCircle size={14} className="animate-spin" />
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
    <div className="flex items-start gap-2 rounded-lg border border-qn-danger/30 bg-qn-danger/10 px-3 py-2 text-[13px] leading-5 text-qn-danger">
      <CircleAlert size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      {onRetry && (
        <button type="button" className="shrink-0 underline underline-offset-2" onClick={onRetry}>
          重试
        </button>
      )}
      {onClose && (
        <button type="button" className="mt-0.5 shrink-0" onClick={onClose} aria-label="关闭提示">
          <X size={14} />
        </button>
      )}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-[13px] leading-6 text-qn-muted">{children}</div>
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
  // 没有 onClose 的对话框（如必须作答的主机密钥确认）不允许被 Esc / 点遮罩关掉。
  const block = onClose ? undefined : (event: Event) => event.preventDefault()
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose?.()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="qn-no-drag qn-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
          <Dialog.Content
            {...(description ? {} : { 'aria-describedby': undefined })}
            onEscapeKeyDown={block}
            onPointerDownOutside={block}
            className={cn(
              'qn-dialog flex max-h-[min(680px,calc(100vh-80px))] w-full flex-col overflow-hidden rounded-2xl border border-qn-border-strong bg-qn-panel shadow-[0_24px_80px_rgba(0,0,0,0.55)] outline-none',
              width,
            )}
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
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
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
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-qn-text">
      <input
        type="checkbox"
        className="h-4 w-4 accent-qn-accent"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  )
}
