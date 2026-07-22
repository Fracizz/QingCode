import { useLayoutEffect, useRef, type ReactNode } from 'react'

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

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

let nextModalId = 0
const modalStack: number[] = []

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(element => {
    return !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true'
  })
}

/** Centered modal overlay — all app dialogs must use this shell. */
export default function ModalOverlay({
  children,
  onDismiss,
  className = '',
  zIndex = 'z-[100]',
  align = 'center',
}: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const onDismissRef = useRef(onDismiss)

  useLayoutEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useLayoutEffect(() => {
    const modalId = ++nextModalId
    const overlay = overlayRef.current
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(modalId)

    if (overlay) {
      const preferred = overlay.querySelector<HTMLElement>('[data-modal-autofocus]')
      const initial = preferred ?? focusableElements(overlay)[0]
      ;(initial ?? overlay).focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== modalId) return

      if (event.key === 'Escape' && onDismissRef.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        onDismissRef.current()
        return
      }

      if (event.key !== 'Tab' || !overlay) return
      const focusable = focusableElements(overlay)
      if (focusable.length === 0) {
        event.preventDefault()
        overlay.focus()
        return
      }

      const active = document.activeElement as HTMLElement | null
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && (active === first || !overlay.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !overlay.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const index = modalStack.lastIndexOf(modalId)
      if (index >= 0) modalStack.splice(index, 1)
      if (modalStack.length > 0) return

      const previous = restoreFocusRef.current
      window.setTimeout(() => {
        if (modalStack.length === 0 && previous?.isConnected) previous.focus()
      }, 0)
    }
  }, [])

  return (
    <div
      ref={overlayRef}
      className={`fixed inset-0 ${zIndex} flex ${align === 'start' ? 'items-start' : 'items-center'} justify-center p-4 ${className}`}
      role="presentation"
      tabIndex={-1}
    >
      <div
        className="modal-overlay-enter absolute inset-0 bg-black/55 backdrop-blur-[3px] transition-all duration-150"
        aria-hidden
        onMouseDown={onDismiss}
      />
      {children}
    </div>
  )
}
