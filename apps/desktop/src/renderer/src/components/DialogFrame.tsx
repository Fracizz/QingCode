import type { ComponentPropsWithoutRef } from 'react'
import { Dialog } from 'radix-ui'
import { cn } from '../lib/cn'

export function DialogFrame({
  open = true,
  onClose,
  described,
  overlayClassName,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof Dialog.Content>, 'onEscapeKeyDown' | 'onPointerDownOutside'> & {
  open?: boolean
  onClose?: () => void
  described?: boolean
  overlayClassName?: string
}) {
  // 主机密钥确认等必须显式作答的对话框不能被 Esc 或遮罩关掉。
  const blockDismiss = onClose ? undefined : (event: Event) => event.preventDefault()

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose?.()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={cn('qn-no-drag fixed inset-0 z-50 bg-black/60', overlayClassName)}>
          <Dialog.Content
            {...(described ? {} : { 'aria-describedby': undefined })}
            onEscapeKeyDown={blockDismiss}
            onPointerDownOutside={blockDismiss}
            className={cn(
              'qn-no-drag flex flex-col overflow-hidden rounded-2xl border border-qn-border-strong bg-qn-panel shadow-[var(--qn-shadow-dialog)] outline-none',
              className,
            )}
            {...props}
          />
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
