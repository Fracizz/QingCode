import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  onDismiss?: () => void
  className?: string
  /** Tailwind z-index utility; nested dialogs (confirm/prompt) must stack
   * above app-level modals like the project manager. */
  zIndex?: string
  /** Vertical alignment of the dialog panel. */
  align?: 'center' | 'start'
}

/** Centered modal overlay — all app dialogs must use this shell. */
export default function ModalOverlay({
  children,
  onDismiss,
  className = '',
  zIndex = 'z-[100]',
  align = 'center',
}: Props) {
  return (
    <div
      className={`fixed inset-0 ${zIndex} flex ${align === 'start' ? 'items-start' : 'items-center'} justify-center p-4 ${className}`}
      role="presentation"
    >
      <div
        className="modal-overlay-enter absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        aria-hidden
        onMouseDown={onDismiss}
      />
      {children}
    </div>
  )
}
