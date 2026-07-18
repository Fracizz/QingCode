import type { ReactNode } from 'react'

interface KbdProps {
  children: ReactNode
}

/** Keyboard-key cap styling for shortcut hints (matches CommandPalette's Esc cap). */
export default function Kbd({ children }: KbdProps) {
  return (
    <kbd className="rounded border border-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] leading-none text-fg-dim">
      {children}
    </kbd>
  )
}
