import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  onDismiss?: () => void
  className?: string
  /** Tailwind z-index utility; nested dialogs (confirm/prompt) must stack
   * above app-level modals like the project manager. */
  zIndex?: string
}

/** Centered modal overlay — all app dialogs must use this shell. */
export default function ModalOverlay({ children, onDismiss, className = '', zIndex = 'z-[100]' }: Props) {
  return (
    <div
      className={`fixed inset-0 ${zIndex} flex items-center justify-center p-4 ${className}`}
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        aria-hidden
        onMouseDown={onDismiss}
      />
      {children}
    </div>
  )
}
