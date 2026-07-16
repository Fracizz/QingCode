import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  onDismiss?: () => void
  className?: string
}

/** Centered modal overlay — all app dialogs must use this shell. */
export default function ModalOverlay({ children, onDismiss, className = '' }: Props) {
  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center p-4 ${className}`}
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
