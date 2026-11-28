import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../lib/cn'

/** 无边框的终端提示符，小尺寸下仍能看清光标。 */
export function TerminalIcon({ size = 14, running = false, className, ...props }: ComponentPropsWithoutRef<'svg'> & {
  size?: number
  running?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0', running && 'text-qn-accent', className)}
      {...props}
    >
      <path d="m4 6 6 6-6 6" />
      <path d="M13 18h7" className={running ? 'qn-terminal-cursor' : undefined} />
    </svg>
  )
}
