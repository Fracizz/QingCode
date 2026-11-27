import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../lib/cn'

/**
 * 方框终端图标（与 lucide SquareTerminal 同形）。运行中时提示符后的光标缓慢闪烁表示进行中，
 * 比转圈更安静；系统要求减少动效时保持静止。
 */
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
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m7 11 2-2-2-2" className={running ? 'qn-terminal-prompt' : undefined} />
      <path d="M11 13h4" className={running ? 'qn-terminal-cursor' : undefined} />
    </svg>
  )
}
