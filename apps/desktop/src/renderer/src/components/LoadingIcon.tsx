import type { ComponentPropsWithoutRef } from 'react'
import { RotateCw } from 'lucide-react'
import { cn } from '../lib/cn'

export function LoadingIcon({ size = 12, className, ...props }: ComponentPropsWithoutRef<'svg'> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 animate-[spin_2s_linear_infinite] text-qn-accent motion-reduce:animate-none', className)}
      {...props}
    >
      <circle cx="6" cy="6" r="5.25" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      <path d="M6 .75a5.25 5.25 0 0 1 5.25 5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function RefreshIcon({ loading, size = 14 }: { loading?: boolean; size?: number }) {
  return loading ? <LoadingIcon size={size} /> : <RotateCw size={size} aria-hidden="true" />
}
